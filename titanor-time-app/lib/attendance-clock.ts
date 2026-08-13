import { createHash } from 'node:crypto';
import { Prisma } from '@prisma/client';
import { prisma } from '@/lib/prisma';
import { createAuditEvent } from '@/lib/audit';
import { overlapCandidates, overlapExists, resolveOverlapTransition } from '@/lib/attendance-reported-projection';
import { materializeClockShiftCore } from '@/lib/attendance-materializer';

// docs/titanor-time/T7A_1_ATTENDANCE_CLOCK_DESIGN.md §9.1/§9.2/§9.3/§9.1a — Online clock core
// (T7A online clock core slice). Route files do HTTP/auth/CSRF/idempotency/validation mapping;
// every business transaction lives here. "*Core" functions accept an existing
// Prisma.TransactionClient and never touch the global `prisma` singleton inside a transaction —
// only the top-level `perform*` wrappers open a `prisma.$transaction(...)`, so a caller composing
// two core steps (Switch Site) can share one transaction, one commit/rollback.
//
// checkOutCore/performSwitchSite call materializeClockShiftCore (lib/attendance-materializer.ts)
// inline, in this same transaction, once sourceAssignmentId is resolved and no OPEN
// OVERLAPPING_SHIFT blocks it (§9.2 step k/§9.3) — never a nested transaction.
//
// EXPLICITLY DEFERRED to a future slice (do not implement here): worker mobile UI,
// GET /attendance/context|today|week, deviceInstallationId/deviceSequence/DeviceEventReceipt FIFO
// (§9.11), POST /attendance/sync, offline outbox, scheduler/cron, exception resolution endpoints,
// admin attendance overview.

const MAX_ACCEPTABLE_ACCURACY_METERS = 75;
const EARTH_RADIUS_METERS = 6371000;
const LATITUDE_MIN = -90;
const LATITUDE_MAX = 90;
const LONGITUDE_MIN = -180;
const LONGITUDE_MAX = 180;
const COORD_DECIMAL_SCALE = 6;
const COORD_SCALE_FACTOR = 10 ** COORD_DECIMAL_SCALE;
const ACCURACY_DECIMAL_SCALE = 1;
const ACCURACY_SCALE_FACTOR = 10 ** ACCURACY_DECIMAL_SCALE;
const ACCURACY_MAX = 99999.9; // fits numeric(6,1)
const FUTURE_TOLERANCE_MS = BigInt(2 * 60000); // §5.5 rule 1
const SKEW_TOLERANCE_MS = BigInt(5 * 60000); // §5.5 rules 2/3
// §9.2 step d clamp: the design specifies "+1 microsecond" (postgres timestamptz(6) precision) —
// this stack round-trips DateTime through JS `Date`, whose precision floor is 1 millisecond. Using
// 1ms instead of 1µs preserves the clamp's actual purpose (a minimal, provably-period-safe nudge
// past `openedAt`) — 1ms is still many orders of magnitude smaller than any realistic payroll
// period, so the "never crosses a period boundary" property the design proves for 1µs holds
// identically for 1ms. lib/attendance-materializer.ts's own fragment-planning tests exercise this
// adaptation directly at a period boundary (openedAt = periodEndExclusive - 1ms).
const CHRONOLOGY_CLAMP_MS = 1;
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export const ATTENDANCE_CLOCK_CONSTANTS = { MAX_ACCEPTABLE_ACCURACY_METERS };

// ---------------------------------------------------------------------------------------------
// 1. GPS evaluation (§5.2) — pure function, Haversine, no PostGIS.
// ---------------------------------------------------------------------------------------------

export type ClientGpsUnavailableReason = 'PERMISSION_DENIED' | 'TIMEOUT' | 'POSITION_UNAVAILABLE';
export type GpsUnavailableReasonValue = ClientGpsUnavailableReason | 'LOW_ACCURACY';
export type GpsVerificationValue = 'VERIFIED_INSIDE' | 'VERIFIED_OUTSIDE' | 'NOT_VERIFIED';

export interface GpsReadingCoordinates {
  latitude: number;
  longitude: number;
  accuracyMeters: number;
}

export interface ClockGpsReading {
  location: GpsReadingCoordinates | null;
  gpsUnavailableReason: ClientGpsUnavailableReason | null;
}

export interface ClockGeofence {
  geofenceVersionId: string;
  latitude: number;
  longitude: number;
  radiusMeters: number;
}

export interface GpsEvaluation {
  gpsVerification: GpsVerificationValue;
  gpsUnavailableReason: GpsUnavailableReasonValue | null;
  geofenceVersionId: string | null;
  gpsAccuracyMeters: number | null;
  distanceMeters: number | null;
  location: { latitude: number; longitude: number } | null;
}

function haversineDistanceMeters(lat1: number, lon1: number, lat2: number, lon2: number): number {
  const toRad = (deg: number): number => (deg * Math.PI) / 180;
  const dLat = toRad(lat2 - lat1);
  const dLon = toRad(lon2 - lon1);
  const a = Math.sin(dLat / 2) ** 2 + Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(dLon / 2) ** 2;
  const c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
  return EARTH_RADIUS_METERS * c;
}

/**
 * §5.2 — evaluates one GPS reading against a site's current geofence (or its absence). Never
 * trusts a geofence version supplied by the client — `geofence` here must always be the caller's
 * own fresh, server-side lookup of the site's authoritative currentGeofenceVersionId.
 */
export function evaluateGpsReading(reading: ClockGpsReading, geofence: ClockGeofence | null): GpsEvaluation {
  if (!reading.location) {
    return { gpsVerification: 'NOT_VERIFIED', gpsUnavailableReason: reading.gpsUnavailableReason, geofenceVersionId: null, gpsAccuracyMeters: null, distanceMeters: null, location: null };
  }
  const { latitude, longitude, accuracyMeters } = reading.location;
  if (accuracyMeters > MAX_ACCEPTABLE_ACCURACY_METERS) {
    return { gpsVerification: 'NOT_VERIFIED', gpsUnavailableReason: 'LOW_ACCURACY', geofenceVersionId: null, gpsAccuracyMeters: accuracyMeters, distanceMeters: null, location: { latitude, longitude } };
  }
  if (!geofence) {
    return { gpsVerification: 'NOT_VERIFIED', gpsUnavailableReason: null, geofenceVersionId: null, gpsAccuracyMeters: accuracyMeters, distanceMeters: null, location: { latitude, longitude } };
  }
  const distanceMeters = haversineDistanceMeters(latitude, longitude, geofence.latitude, geofence.longitude);
  const effectiveRadius = geofence.radiusMeters + accuracyMeters;
  const inside = distanceMeters <= effectiveRadius;
  return {
    gpsVerification: inside ? 'VERIFIED_INSIDE' : 'VERIFIED_OUTSIDE',
    gpsUnavailableReason: null,
    geofenceVersionId: geofence.geofenceVersionId,
    gpsAccuracyMeters: accuracyMeters,
    distanceMeters,
    location: { latitude, longitude }
  };
}

// ---------------------------------------------------------------------------------------------
// 2. Online effective time / clock skew (§5.5 rules 1-3 — ONLINE channel only, this slice never
//    handles OFFLINE_SYNC/rules 4-5).
// ---------------------------------------------------------------------------------------------

export interface EffectiveTimeResult {
  effectiveAt: Date;
  clockSkewMs: bigint;
  exception: 'EXCESSIVE_CLOCK_SKEW' | null;
}

/** clockSkewMs = serverReceivedAt - clientCapturedAt, computed via BigInt throughout — two valid
 * Date instants can each individually fit in a safe JS integer yet have a difference that doesn't
 * (a device reset to the 1970 epoch against a serverReceivedAt decades later), so plain Number
 * subtraction is not safe here; bigint also matches the ClockEvent.clockSkewMs column type. */
export function computeOnlineEffectiveTime(clientCapturedAt: Date, serverReceivedAt: Date): EffectiveTimeResult {
  const clockSkewMs = BigInt(serverReceivedAt.getTime()) - BigInt(clientCapturedAt.getTime());
  const futureByMs = -clockSkewMs;

  if (futureByMs > FUTURE_TOLERANCE_MS) {
    return { effectiveAt: serverReceivedAt, clockSkewMs, exception: 'EXCESSIVE_CLOCK_SKEW' };
  }
  const absSkew = clockSkewMs < BigInt(0) ? -clockSkewMs : clockSkewMs;
  if (absSkew <= SKEW_TOLERANCE_MS) {
    return { effectiveAt: clientCapturedAt, clockSkewMs, exception: null };
  }
  return { effectiveAt: serverReceivedAt, clockSkewMs, exception: 'EXCESSIVE_CLOCK_SKEW' };
}

// ---------------------------------------------------------------------------------------------
// Shared date/validation helpers.
// ---------------------------------------------------------------------------------------------

export function isValidUuid(value: unknown): value is string {
  return typeof value === 'string' && UUID_PATTERN.test(value);
}

/** Parses an ISO-8601 string into a Date, rejecting anything that doesn't round-trip to a valid
 * instant (§5.5 "invalid/unrepresentable timestamps -> VALIDATION_ERROR"). */
export function parseIsoInstant(value: unknown): Date | null {
  if (typeof value !== 'string' || value.trim().length === 0) {
    return null;
  }
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? null : date;
}

function roundTripDecimal(value: number, scaleFactor: number): boolean {
  return Math.round(value * scaleFactor) / scaleFactor === value;
}

function helsinkiCalendarDateAsUtcMidnight(instant: Date): Date {
  const dateStr = new Intl.DateTimeFormat('en-CA', { timeZone: 'Europe/Helsinki' }).format(instant);
  return new Date(`${dateStr}T00:00:00.000Z`);
}

async function resolveTimesheetForInstant(tx: Prisma.TransactionClient, employeeId: string, instant: Date): Promise<{ timesheetId: string | null; payrollPeriodId: string | null }> {
  const date = helsinkiCalendarDateAsUtcMidnight(instant);
  const timesheet = await tx.timesheet.findFirst({
    where: { employeeId, period: { startDate: { lte: date }, endDate: { gte: date } } },
    select: { id: true, periodId: true }
  });
  return timesheet ? { timesheetId: timesheet.id, payrollPeriodId: timesheet.periodId } : { timesheetId: null, payrollPeriodId: null };
}

async function resolveActiveSiteAssignment(tx: Prisma.TransactionClient, employeeId: string, siteId: string, workAreaId: string | null, instant: Date): Promise<string | null> {
  const date = helsinkiCalendarDateAsUtcMidnight(instant);
  const assignment = await tx.siteAssignment.findFirst({
    where: { employeeId, siteId, workAreaId, validFrom: { lte: date }, OR: [{ validTo: null }, { validTo: { gte: date } }] },
    select: { id: true }
  });
  return assignment?.id ?? null;
}

// ---------------------------------------------------------------------------------------------
// GPS payload validation (§14 shape rules — shared by check-in/check-out/switch-site halves).
// ---------------------------------------------------------------------------------------------

export type ValidationResult<T> = { ok: true; value: T } | { ok: false; fieldErrors: Record<string, string[]> };

const CLIENT_GPS_UNAVAILABLE_REASONS = new Set<string>(['PERMISSION_DENIED', 'TIMEOUT', 'POSITION_UNAVAILABLE']);

function validateGpsPayload(rawLocation: unknown, rawReason: unknown, locationField: string, reasonField: string): ValidationResult<ClockGpsReading> {
  const fieldErrors: Record<string, string[]> = {};

  if (rawLocation === undefined) {
    fieldErrors[locationField] = ['required (an object or null)'];
    return { ok: false, fieldErrors };
  }

  if (rawLocation === null) {
    if (typeof rawReason !== 'string' || !CLIENT_GPS_UNAVAILABLE_REASONS.has(rawReason)) {
      fieldErrors[reasonField] = ['required (PERMISSION_DENIED|TIMEOUT|POSITION_UNAVAILABLE) when location is null'];
      return { ok: false, fieldErrors };
    }
    return { ok: true, value: { location: null, gpsUnavailableReason: rawReason as ClientGpsUnavailableReason } };
  }

  if (typeof rawLocation !== 'object' || Array.isArray(rawLocation)) {
    fieldErrors[locationField] = ['must be an object or null'];
    return { ok: false, fieldErrors };
  }

  if (rawReason !== null && rawReason !== undefined) {
    fieldErrors[reasonField] = ['must be null when location is present'];
  }

  const { latitude, longitude, accuracyMeters } = rawLocation as Record<string, unknown>;

  if (typeof latitude !== 'number' || !Number.isFinite(latitude)) {
    fieldErrors[`${locationField}.latitude`] = ['required'];
  } else if (latitude < LATITUDE_MIN || latitude > LATITUDE_MAX) {
    fieldErrors[`${locationField}.latitude`] = [`must be between ${LATITUDE_MIN} and ${LATITUDE_MAX}`];
  } else if (!roundTripDecimal(latitude, COORD_SCALE_FACTOR)) {
    fieldErrors[`${locationField}.latitude`] = [`must have at most ${COORD_DECIMAL_SCALE} decimal places`];
  }

  if (typeof longitude !== 'number' || !Number.isFinite(longitude)) {
    fieldErrors[`${locationField}.longitude`] = ['required'];
  } else if (longitude < LONGITUDE_MIN || longitude > LONGITUDE_MAX) {
    fieldErrors[`${locationField}.longitude`] = [`must be between ${LONGITUDE_MIN} and ${LONGITUDE_MAX}`];
  } else if (!roundTripDecimal(longitude, COORD_SCALE_FACTOR)) {
    fieldErrors[`${locationField}.longitude`] = [`must have at most ${COORD_DECIMAL_SCALE} decimal places`];
  }

  if (typeof accuracyMeters !== 'number' || !Number.isFinite(accuracyMeters)) {
    fieldErrors[`${locationField}.accuracyMeters`] = ['required'];
  } else if (accuracyMeters < 0 || accuracyMeters > ACCURACY_MAX) {
    fieldErrors[`${locationField}.accuracyMeters`] = [`must be between 0 and ${ACCURACY_MAX}`];
  } else if (!roundTripDecimal(accuracyMeters, ACCURACY_SCALE_FACTOR)) {
    fieldErrors[`${locationField}.accuracyMeters`] = [`must have at most ${ACCURACY_DECIMAL_SCALE} decimal place`];
  }

  if (Object.keys(fieldErrors).length > 0) {
    return { ok: false, fieldErrors };
  }

  return { ok: true, value: { location: { latitude: latitude as number, longitude: longitude as number, accuracyMeters: accuracyMeters as number }, gpsUnavailableReason: null } };
}

// ---------------------------------------------------------------------------------------------
// Body validators.
// ---------------------------------------------------------------------------------------------

export interface CheckInInput {
  clientEventId: string;
  siteId: string;
  workAreaId: string | null;
  clientCapturedAt: Date;
  gps: ClockGpsReading;
}

export function validateCheckInBody(raw: Record<string, unknown>): ValidationResult<CheckInInput> {
  const fieldErrors: Record<string, string[]> = {};

  if (!isValidUuid(raw.clientEventId)) {
    fieldErrors.clientEventId = ['required, must be a UUID'];
  }
  if (!isValidUuid(raw.siteId)) {
    fieldErrors.siteId = ['required, must be a UUID'];
  }
  let workAreaId: string | null = null;
  if (raw.workAreaId !== null && raw.workAreaId !== undefined) {
    if (!isValidUuid(raw.workAreaId)) {
      fieldErrors.workAreaId = ['must be a UUID or null'];
    } else {
      workAreaId = raw.workAreaId as string;
    }
  }
  const clientCapturedAt = parseIsoInstant(raw.clientCapturedAt);
  if (!clientCapturedAt) {
    fieldErrors.clientCapturedAt = ['required, must be a valid ISO-8601 timestamp'];
  }
  const gps = validateGpsPayload(raw.location, raw.gpsUnavailableReason, 'location', 'gpsUnavailableReason');
  if (!gps.ok) {
    Object.assign(fieldErrors, gps.fieldErrors);
  }

  if (Object.keys(fieldErrors).length > 0 || !clientCapturedAt || !gps.ok) {
    return { ok: false, fieldErrors };
  }
  return { ok: true, value: { clientEventId: raw.clientEventId as string, siteId: raw.siteId as string, workAreaId, clientCapturedAt, gps: gps.value } };
}

export interface CheckOutInput {
  clientEventId: string;
  assumedSiteId: string;
  clientCapturedAt: Date;
  gps: ClockGpsReading;
}

export function validateCheckOutBody(raw: Record<string, unknown>): ValidationResult<CheckOutInput> {
  const fieldErrors: Record<string, string[]> = {};

  if (!isValidUuid(raw.clientEventId)) {
    fieldErrors.clientEventId = ['required, must be a UUID'];
  }
  if (!isValidUuid(raw.assumedSiteId)) {
    fieldErrors.assumedSiteId = ['required, must be a UUID'];
  }
  const clientCapturedAt = parseIsoInstant(raw.clientCapturedAt);
  if (!clientCapturedAt) {
    fieldErrors.clientCapturedAt = ['required, must be a valid ISO-8601 timestamp'];
  }
  const gps = validateGpsPayload(raw.location, raw.gpsUnavailableReason, 'location', 'gpsUnavailableReason');
  if (!gps.ok) {
    Object.assign(fieldErrors, gps.fieldErrors);
  }

  if (Object.keys(fieldErrors).length > 0 || !clientCapturedAt || !gps.ok) {
    return { ok: false, fieldErrors };
  }
  return { ok: true, value: { clientEventId: raw.clientEventId as string, assumedSiteId: raw.assumedSiteId as string, clientCapturedAt, gps: gps.value } };
}

export interface SwitchSiteInput {
  groupId: string;
  checkOutClientEventId: string;
  checkInClientEventId: string;
  oldAssumedSiteId: string;
  newSiteId: string;
  newWorkAreaId: string | null;
  checkOutClientCapturedAt: Date;
  checkInClientCapturedAt: Date;
  checkOutGps: ClockGpsReading;
  checkInGps: ClockGpsReading;
}

export function validateSwitchSiteBody(raw: Record<string, unknown>): ValidationResult<SwitchSiteInput> {
  const fieldErrors: Record<string, string[]> = {};

  if (!isValidUuid(raw.groupId)) {
    fieldErrors.groupId = ['required, must be a UUID'];
  }
  if (!isValidUuid(raw.checkOutClientEventId)) {
    fieldErrors.checkOutClientEventId = ['required, must be a UUID'];
  }
  if (!isValidUuid(raw.checkInClientEventId)) {
    fieldErrors.checkInClientEventId = ['required, must be a UUID'];
  }
  if (isValidUuid(raw.checkOutClientEventId) && isValidUuid(raw.checkInClientEventId) && raw.checkOutClientEventId === raw.checkInClientEventId) {
    fieldErrors.checkInClientEventId = ['must differ from checkOutClientEventId'];
  }
  if (!isValidUuid(raw.oldAssumedSiteId)) {
    fieldErrors.oldAssumedSiteId = ['required, must be a UUID'];
  }
  if (!isValidUuid(raw.newSiteId)) {
    fieldErrors.newSiteId = ['required, must be a UUID'];
  }
  let newWorkAreaId: string | null = null;
  if (raw.newWorkAreaId !== null && raw.newWorkAreaId !== undefined) {
    if (!isValidUuid(raw.newWorkAreaId)) {
      fieldErrors.newWorkAreaId = ['must be a UUID or null'];
    } else {
      newWorkAreaId = raw.newWorkAreaId as string;
    }
  }
  const checkOutClientCapturedAt = parseIsoInstant(raw.checkOutClientCapturedAt);
  if (!checkOutClientCapturedAt) {
    fieldErrors.checkOutClientCapturedAt = ['required, must be a valid ISO-8601 timestamp'];
  }
  const checkInClientCapturedAt = parseIsoInstant(raw.checkInClientCapturedAt);
  if (!checkInClientCapturedAt) {
    fieldErrors.checkInClientCapturedAt = ['required, must be a valid ISO-8601 timestamp'];
  }
  const checkOutGps = validateGpsPayload(raw.checkOutLocation, raw.checkOutGpsUnavailableReason, 'checkOutLocation', 'checkOutGpsUnavailableReason');
  if (!checkOutGps.ok) {
    Object.assign(fieldErrors, checkOutGps.fieldErrors);
  }
  const checkInGps = validateGpsPayload(raw.checkInLocation, raw.checkInGpsUnavailableReason, 'checkInLocation', 'checkInGpsUnavailableReason');
  if (!checkInGps.ok) {
    Object.assign(fieldErrors, checkInGps.fieldErrors);
  }

  if (Object.keys(fieldErrors).length > 0 || !checkOutClientCapturedAt || !checkInClientCapturedAt || !checkOutGps.ok || !checkInGps.ok) {
    return { ok: false, fieldErrors };
  }
  return {
    ok: true,
    value: {
      groupId: raw.groupId as string,
      checkOutClientEventId: raw.checkOutClientEventId as string,
      checkInClientEventId: raw.checkInClientEventId as string,
      oldAssumedSiteId: raw.oldAssumedSiteId as string,
      newSiteId: raw.newSiteId as string,
      newWorkAreaId,
      checkOutClientCapturedAt,
      checkInClientCapturedAt,
      checkOutGps: checkOutGps.value,
      checkInGps: checkInGps.value
    }
  };
}

// ---------------------------------------------------------------------------------------------
// Payload hashing (§14 — natural idempotency key is ClockEvent.id; payloadHash detects a changed
// replay under the same id). employeeId is always the session-resolved one, never from the body.
// Coordinates participate in the hash (so a moved reading under the same clientEventId is
// detected as a conflict) but the hash itself never appears in logs/audit, and coordinates never
// appear anywhere else outside ClockEventLocation (§4.3).
// ---------------------------------------------------------------------------------------------

function canonicalizeForHash(value: unknown): string {
  if (Array.isArray(value)) {
    return `[${value.map(canonicalizeForHash).join(',')}]`;
  }
  if (value !== null && typeof value === 'object') {
    const obj = value as Record<string, unknown>;
    const keys = Object.keys(obj).sort();
    return `{${keys.map((k) => `${JSON.stringify(k)}:${canonicalizeForHash(obj[k])}`).join(',')}}`;
  }
  return JSON.stringify(value);
}

interface EventHashInput {
  employeeId: string;
  clientEventId: string;
  operationType: 'CHECK_IN' | 'CHECK_OUT';
  groupId: string | null;
  siteId: string | null;
  assumedSiteId: string | null;
  workAreaId: string | null;
  clientCapturedAt: string;
  gps: ClockGpsReading;
}

function checkInHashInput(employeeId: string, groupId: string | null, input: CheckInInput): EventHashInput {
  return { employeeId, clientEventId: input.clientEventId, operationType: 'CHECK_IN', groupId, siteId: input.siteId, assumedSiteId: null, workAreaId: input.workAreaId, clientCapturedAt: input.clientCapturedAt.toISOString(), gps: input.gps };
}

function checkOutHashInput(employeeId: string, groupId: string | null, input: CheckOutInput): EventHashInput {
  return { employeeId, clientEventId: input.clientEventId, operationType: 'CHECK_OUT', groupId, siteId: null, assumedSiteId: input.assumedSiteId, workAreaId: null, clientCapturedAt: input.clientCapturedAt.toISOString(), gps: input.gps };
}

function computeClockEventPayloadHash(input: EventHashInput): string {
  return createHash('sha256').update(canonicalizeForHash(input as unknown as Record<string, unknown>)).digest('hex');
}

/** §4.3/§14 — sanitized conflict payload: never latitude/longitude/accuracy/raw body. */
function sanitizedConflictPayload(input: EventHashInput): Prisma.InputJsonValue {
  return {
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

async function recordClientEventConflict(tx: Prisma.TransactionClient, employeeId: string, requestId: string, input: EventHashInput, payloadHash: string): Promise<void> {
  await tx.clockEventIdConflict.create({
    data: {
      conflictType: 'CLIENT_EVENT_ID_REUSED',
      clientEventId: input.clientEventId,
      employeeId,
      deviceInstallationId: null,
      sanitizedConflictingPayload: sanitizedConflictPayload(input),
      conflictingPayloadHash: payloadHash,
      requestId
    }
  });
}

type ReplayCheck = { kind: 'FRESH' } | { kind: 'EXACT_REPLAY' } | { kind: 'CONFLICT' };

async function checkClientEventReplay(tx: Prisma.TransactionClient, clientEventId: string, payloadHash: string): Promise<ReplayCheck> {
  const existing = await tx.clockEvent.findUnique({ where: { id: clientEventId }, select: { payloadHash: true } });
  if (!existing) {
    return { kind: 'FRESH' };
  }
  return existing.payloadHash === payloadHash ? { kind: 'EXACT_REPLAY' } : { kind: 'CONFLICT' };
}

// ---------------------------------------------------------------------------------------------
// Deterministic response reconstruction — same function builds the response for a freshly
// created event and for an exact replay of an old one, from durable rows only (never from
// point-in-time "current" state like EmployeeOpenShift, which can legitimately have moved on).
// ---------------------------------------------------------------------------------------------

export interface ClockEventResponseBody {
  clockEventId: string;
  operationType: 'CHECK_IN' | 'CHECK_OUT';
  processingState: 'ACCEPTED' | 'NEEDS_REVIEW';
  gpsVerification: GpsVerificationValue;
  effectiveAt: string;
  siteId: string;
  assumedSiteId: string | null;
  workAreaId: string | null;
  sourceAssignmentId: string | null;
  groupId: string | null;
  clockShiftId: string | null;
  materializationState: 'PENDING' | 'MATERIALIZED' | null;
  exceptions: string[];
}

/**
 * Reads live, not frozen at creation time — a natural `clientEventId` replay of an old checkout must reflect
 * materializationState as it stands NOW (§B "durable response отражает актуальное
 * materializationState"), e.g. a shift that was PENDING (overlap-blocked) when first created but
 * later materialized by a catch-up pass shows MATERIALIZED on a subsequent replay of the same
 * clientEventId, without ever re-running the checkout's own business mutation.
 */
async function buildEventResponse(tx: Prisma.TransactionClient, clockEventId: string): Promise<ClockEventResponseBody> {
  const event = await tx.clockEvent.findUniqueOrThrow({
    where: { id: clockEventId },
    select: {
      id: true,
      operationType: true,
      processingState: true,
      gpsVerification: true,
      effectiveAt: true,
      siteId: true,
      assumedSiteId: true,
      workAreaId: true,
      sourceAssignmentId: true,
      groupId: true,
      checkOutForShift: { select: { id: true, materializationState: true } }
    }
  });
  const exceptions = await tx.attendanceException.findMany({ where: { clockEventId }, select: { type: true }, orderBy: { type: 'asc' } });
  return {
    clockEventId: event.id,
    operationType: event.operationType,
    processingState: event.processingState,
    gpsVerification: event.gpsVerification,
    effectiveAt: event.effectiveAt.toISOString(),
    siteId: event.siteId,
    assumedSiteId: event.assumedSiteId,
    workAreaId: event.workAreaId,
    sourceAssignmentId: event.sourceAssignmentId,
    groupId: event.groupId,
    materializationState: event.checkOutForShift?.materializationState ?? null,
    clockShiftId: event.checkOutForShift?.id ?? null,
    exceptions: exceptions.map((e) => e.type)
  };
}

// ---------------------------------------------------------------------------------------------
// 3. Clock state (read-only, no lock — nothing here mutates).
// ---------------------------------------------------------------------------------------------

export interface ClockStateOpenShift {
  openedAt: string;
  siteId: string;
  siteName: string;
  workAreaId: string | null;
  workAreaName: string | null;
  sourceAssignmentId: string | null;
  openedByClockEventId: string;
}

export interface ClockStateView {
  serverNow: string;
  state: 'CLOCKED_OUT' | 'CLOCKED_IN';
  openShift: ClockStateOpenShift | null;
}

export async function getClockState(employeeId: string): Promise<ClockStateView> {
  const serverNow = new Date();
  const openShift = await prisma.employeeOpenShift.findUnique({
    where: { employeeId },
    select: {
      openedAt: true,
      siteId: true,
      site: { select: { name: true } },
      workAreaId: true,
      workArea: { select: { name: true } },
      sourceAssignmentId: true,
      openedByClockEventId: true
    }
  });
  if (!openShift) {
    return { serverNow: serverNow.toISOString(), state: 'CLOCKED_OUT', openShift: null };
  }
  return {
    serverNow: serverNow.toISOString(),
    state: 'CLOCKED_IN',
    openShift: {
      openedAt: openShift.openedAt.toISOString(),
      siteId: openShift.siteId,
      siteName: openShift.site.name,
      workAreaId: openShift.workAreaId,
      workAreaName: openShift.workArea?.name ?? null,
      sourceAssignmentId: openShift.sourceAssignmentId,
      openedByClockEventId: openShift.openedByClockEventId
    }
  };
}

// ---------------------------------------------------------------------------------------------
// Shared low-level building blocks used by checkInCore/checkOutCore/switch-site.
// ---------------------------------------------------------------------------------------------

class OutsideGeofenceSignal extends Error {}
class NoOpenShiftToSwitchSignal extends Error {}

async function loadCurrentGeofence(tx: Prisma.TransactionClient, siteId: string): Promise<ClockGeofence | null> {
  const site = await tx.workSite.findUnique({ where: { id: siteId }, select: { currentGeofenceVersionId: true } });
  if (!site?.currentGeofenceVersionId) {
    return null;
  }
  const version = await tx.workSiteGeofenceVersion.findUnique({
    where: { id: site.currentGeofenceVersionId },
    select: { id: true, latitude: true, longitude: true, radiusMeters: true }
  });
  if (!version) {
    return null;
  }
  return { geofenceVersionId: version.id, latitude: Number(version.latitude), longitude: Number(version.longitude), radiusMeters: version.radiusMeters };
}

function exceptionDetailForGps(evaluation: GpsEvaluation, geofence: ClockGeofence | null): Prisma.InputJsonValue | undefined {
  if (evaluation.gpsVerification === 'VERIFIED_OUTSIDE' && geofence && evaluation.distanceMeters !== null) {
    return { distanceMeters: Math.round(evaluation.distanceMeters), accuracyMeters: evaluation.gpsAccuracyMeters, thresholdMeters: geofence.radiusMeters };
  }
  if (evaluation.gpsVerification === 'NOT_VERIFIED') {
    if (evaluation.gpsUnavailableReason) {
      return { reason: evaluation.gpsUnavailableReason };
    }
    return { reason: 'NO_GEOFENCE_CONFIGURED' };
  }
  return undefined;
}

// ---------------------------------------------------------------------------------------------
// 4. Check In core (§9.1).
// ---------------------------------------------------------------------------------------------

export type CheckInOutcome =
  | { kind: 'CREATED'; body: ClockEventResponseBody }
  | { kind: 'REPLAY'; body: ClockEventResponseBody }
  | { kind: 'CONFLICT' }
  | { kind: 'OUTSIDE_GEOFENCE' }
  | { kind: 'SITE_NOT_FOUND' }
  | { kind: 'WORK_AREA_INVALID' };

async function checkInCore(tx: Prisma.TransactionClient, employeeId: string, actorUserId: string, requestId: string, input: CheckInInput, groupId: string | null): Promise<CheckInOutcome> {
  const hashInput = checkInHashInput(employeeId, groupId, input);
  const payloadHash = computeClockEventPayloadHash(hashInput);

  const replay = await checkClientEventReplay(tx, input.clientEventId, payloadHash);
  if (replay.kind === 'EXACT_REPLAY') {
    return { kind: 'REPLAY', body: await buildEventResponse(tx, input.clientEventId) };
  }
  if (replay.kind === 'CONFLICT') {
    await recordClientEventConflict(tx, employeeId, requestId, hashInput, payloadHash);
    return { kind: 'CONFLICT' };
  }

  const site = await tx.workSite.findUnique({ where: { id: input.siteId }, select: { id: true } });
  if (!site) {
    return { kind: 'SITE_NOT_FOUND' };
  }
  if (input.workAreaId) {
    const workArea = await tx.workArea.findFirst({ where: { id: input.workAreaId, siteId: input.siteId }, select: { id: true } });
    if (!workArea) {
      return { kind: 'WORK_AREA_INVALID' };
    }
  }

  const geofence = await loadCurrentGeofence(tx, input.siteId);
  const gpsResult = evaluateGpsReading(input.gps, geofence);

  if (gpsResult.gpsVerification === 'VERIFIED_OUTSIDE') {
    throw new OutsideGeofenceSignal();
  }

  const openShift = await tx.employeeOpenShift.findUnique({ where: { employeeId }, select: { employeeId: true } });
  const serverReceivedAt = new Date();
  const timeResult = computeOnlineEffectiveTime(input.clientCapturedAt, serverReceivedAt);
  const { timesheetId, payrollPeriodId } = await resolveTimesheetForInstant(tx, employeeId, timeResult.effectiveAt);

  if (openShift) {
    await tx.clockEvent.create({
      data: {
        id: input.clientEventId,
        groupId,
        employeeId,
        operationType: 'CHECK_IN',
        siteId: input.siteId,
        workAreaId: input.workAreaId,
        sourceAssignmentId: null,
        clientCapturedAt: input.clientCapturedAt,
        capturedOffline: false,
        serverReceivedAt,
        effectiveAt: timeResult.effectiveAt,
        clockSkewMs: timeResult.clockSkewMs,
        gpsAccuracyMeters: gpsResult.gpsAccuracyMeters,
        geofenceVersionId: gpsResult.geofenceVersionId,
        gpsVerification: gpsResult.gpsVerification,
        gpsUnavailableReason: gpsResult.gpsUnavailableReason,
        processingState: 'NEEDS_REVIEW',
        channel: 'ONLINE',
        payloadHash,
        requestId
      }
    });
    if (gpsResult.location) {
      await tx.clockEventLocation.create({ data: { clockEventId: input.clientEventId, latitude: gpsResult.location.latitude, longitude: gpsResult.location.longitude } });
    }
    await tx.attendanceException.create({
      data: { type: 'DOUBLE_CHECK_IN', employeeId, timesheetId, payrollPeriodId, occurredAt: timeResult.effectiveAt, siteId: input.siteId, clockEventId: input.clientEventId, status: 'OPEN' }
    });
    if (gpsResult.gpsVerification === 'NOT_VERIFIED') {
      await tx.attendanceException.create({
        data: { type: 'GPS_NOT_VERIFIED', employeeId, timesheetId, payrollPeriodId, occurredAt: timeResult.effectiveAt, siteId: input.siteId, clockEventId: input.clientEventId, status: 'OPEN', detail: exceptionDetailForGps(gpsResult, geofence) }
      });
    }
    if (timeResult.exception === 'EXCESSIVE_CLOCK_SKEW') {
      await tx.attendanceException.create({
        data: { type: 'EXCESSIVE_CLOCK_SKEW', employeeId, timesheetId, payrollPeriodId, occurredAt: timeResult.effectiveAt, siteId: input.siteId, clockEventId: input.clientEventId, status: 'OPEN', detail: { clockSkewMs: timeResult.clockSkewMs.toString() } }
      });
    }
    await createAuditEvent(tx, {
      actorUserId,
      eventType: 'CLOCK_CHECK_IN_REJECTED_DOUBLE',
      entityType: 'CLOCK_EVENT',
      entityId: input.clientEventId,
      requestId,
      beforeValue: null,
      afterValue: { operationType: 'CHECK_IN', processingState: 'NEEDS_REVIEW', siteId: input.siteId }
    });
    return { kind: 'CREATED', body: await buildEventResponse(tx, input.clientEventId) };
  }

  const sourceAssignmentId = await resolveActiveSiteAssignment(tx, employeeId, input.siteId, input.workAreaId, timeResult.effectiveAt);

  await tx.clockEvent.create({
    data: {
      id: input.clientEventId,
      groupId,
      employeeId,
      operationType: 'CHECK_IN',
      siteId: input.siteId,
      workAreaId: input.workAreaId,
      sourceAssignmentId,
      clientCapturedAt: input.clientCapturedAt,
      capturedOffline: false,
      serverReceivedAt,
      effectiveAt: timeResult.effectiveAt,
      clockSkewMs: timeResult.clockSkewMs,
      gpsAccuracyMeters: gpsResult.gpsAccuracyMeters,
      geofenceVersionId: gpsResult.geofenceVersionId,
      gpsVerification: gpsResult.gpsVerification,
      gpsUnavailableReason: gpsResult.gpsUnavailableReason,
      processingState: 'ACCEPTED',
      channel: 'ONLINE',
      payloadHash,
      requestId
    }
  });
  if (gpsResult.location) {
    await tx.clockEventLocation.create({ data: { clockEventId: input.clientEventId, latitude: gpsResult.location.latitude, longitude: gpsResult.location.longitude } });
  }
  await tx.employeeOpenShift.create({
    data: { employeeId, openedByClockEventId: input.clientEventId, siteId: input.siteId, workAreaId: input.workAreaId, sourceAssignmentId, openedAt: timeResult.effectiveAt }
  });

  if (gpsResult.gpsVerification === 'NOT_VERIFIED') {
    await tx.attendanceException.create({
      data: { type: 'GPS_NOT_VERIFIED', employeeId, timesheetId, payrollPeriodId, occurredAt: timeResult.effectiveAt, siteId: input.siteId, clockEventId: input.clientEventId, status: 'OPEN', detail: exceptionDetailForGps(gpsResult, geofence) }
    });
  }
  if (!sourceAssignmentId) {
    await tx.attendanceException.create({
      data: { type: 'STALE_ASSIGNMENT', employeeId, timesheetId, payrollPeriodId, occurredAt: timeResult.effectiveAt, siteId: input.siteId, clockEventId: input.clientEventId, clockShiftId: null, status: 'OPEN' }
    });
  }
  if (timeResult.exception === 'EXCESSIVE_CLOCK_SKEW') {
    await tx.attendanceException.create({
      data: { type: 'EXCESSIVE_CLOCK_SKEW', employeeId, timesheetId, payrollPeriodId, occurredAt: timeResult.effectiveAt, siteId: input.siteId, clockEventId: input.clientEventId, status: 'OPEN', detail: { clockSkewMs: timeResult.clockSkewMs.toString() } }
    });
  }

  await createAuditEvent(tx, {
    actorUserId,
    eventType: 'CLOCK_CHECK_IN',
    entityType: 'CLOCK_EVENT',
    entityId: input.clientEventId,
    requestId,
    beforeValue: null,
    afterValue: { operationType: 'CHECK_IN', processingState: 'ACCEPTED', siteId: input.siteId, workAreaId: input.workAreaId }
  });

  return { kind: 'CREATED', body: await buildEventResponse(tx, input.clientEventId) };
}

async function resolveConflictAfterRace(clientEventId: string, employeeId: string, requestId: string, hashInput: EventHashInput, payloadHash: string): Promise<'REPLAY' | 'CONFLICT'> {
  return prisma.$transaction(async (tx) => {
    const existing = await tx.clockEvent.findUnique({ where: { id: clientEventId }, select: { payloadHash: true } });
    if (existing && existing.payloadHash === payloadHash) {
      return 'REPLAY';
    }
    await recordClientEventConflict(tx, employeeId, requestId, hashInput, payloadHash);
    return 'CONFLICT';
  });
}

export async function performCheckIn(employeeId: string, actorUserId: string, requestId: string, input: CheckInInput): Promise<CheckInOutcome> {
  try {
    return await prisma.$transaction(async (tx) => {
      await tx.$queryRaw`SELECT id FROM "Employee" WHERE id = ${employeeId}::uuid FOR UPDATE`;
      return checkInCore(tx, employeeId, actorUserId, requestId, input, null);
    });
  } catch (err) {
    if (err instanceof OutsideGeofenceSignal) {
      return { kind: 'OUTSIDE_GEOFENCE' };
    }
    if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === 'P2002') {
      const hashInput = checkInHashInput(employeeId, null, input);
      const payloadHash = computeClockEventPayloadHash(hashInput);
      const outcome = await resolveConflictAfterRace(input.clientEventId, employeeId, requestId, hashInput, payloadHash);
      if (outcome === 'REPLAY') {
        return { kind: 'REPLAY', body: await buildEventResponseStandalone(input.clientEventId) };
      }
      return { kind: 'CONFLICT' };
    }
    throw err;
  }
}

async function buildEventResponseStandalone(clockEventId: string): Promise<ClockEventResponseBody> {
  return prisma.$transaction((tx) => buildEventResponse(tx, clockEventId));
}

// ---------------------------------------------------------------------------------------------
// 5. Check Out core (§9.2).
// ---------------------------------------------------------------------------------------------

export type CheckOutOutcome =
  | { kind: 'CREATED'; body: ClockEventResponseBody }
  | { kind: 'REPLAY'; body: ClockEventResponseBody }
  | { kind: 'CONFLICT' }
  | { kind: 'SITE_NOT_FOUND' };

/**
 * §9.2. `forbidOrphan=true` is used by Switch Site (§9.3 step 2 — "должна существовать ... иначе
 * 409 NO_OPEN_SHIFT_TO_SWITCH"), which throws NoOpenShiftToSwitchSignal instead of the standalone
 * endpoint's normal orphan-checkout handling.
 */
async function checkOutCore(tx: Prisma.TransactionClient, employeeId: string, actorUserId: string, requestId: string, input: CheckOutInput, groupId: string | null, forbidOrphan: boolean): Promise<CheckOutOutcome> {
  const hashInput = checkOutHashInput(employeeId, groupId, input);
  const payloadHash = computeClockEventPayloadHash(hashInput);

  const replay = await checkClientEventReplay(tx, input.clientEventId, payloadHash);
  if (replay.kind === 'EXACT_REPLAY') {
    return { kind: 'REPLAY', body: await buildEventResponse(tx, input.clientEventId) };
  }
  if (replay.kind === 'CONFLICT') {
    await recordClientEventConflict(tx, employeeId, requestId, hashInput, payloadHash);
    return { kind: 'CONFLICT' };
  }

  const assumedSite = await tx.workSite.findUnique({ where: { id: input.assumedSiteId }, select: { id: true } });
  if (!assumedSite) {
    return { kind: 'SITE_NOT_FOUND' };
  }

  await tx.$queryRaw`SELECT "employeeId" FROM "EmployeeOpenShift" WHERE "employeeId" = ${employeeId}::uuid FOR UPDATE`;
  const openShift = await tx.employeeOpenShift.findUnique({ where: { employeeId } });

  const serverReceivedAt = new Date();

  if (!openShift) {
    if (forbidOrphan) {
      throw new NoOpenShiftToSwitchSignal();
    }
    const timeResult = computeOnlineEffectiveTime(input.clientCapturedAt, serverReceivedAt);
    const { timesheetId, payrollPeriodId } = await resolveTimesheetForInstant(tx, employeeId, timeResult.effectiveAt);
    const geofence = await loadCurrentGeofence(tx, input.assumedSiteId);
    const gpsResult = evaluateGpsReading(input.gps, geofence);

    await tx.clockEvent.create({
      data: {
        id: input.clientEventId,
        groupId,
        employeeId,
        operationType: 'CHECK_OUT',
        siteId: input.assumedSiteId,
        assumedSiteId: input.assumedSiteId,
        workAreaId: null,
        sourceAssignmentId: null,
        clientCapturedAt: input.clientCapturedAt,
        capturedOffline: false,
        serverReceivedAt,
        effectiveAt: timeResult.effectiveAt,
        clockSkewMs: timeResult.clockSkewMs,
        gpsAccuracyMeters: gpsResult.gpsAccuracyMeters,
        geofenceVersionId: gpsResult.geofenceVersionId,
        gpsVerification: gpsResult.gpsVerification,
        gpsUnavailableReason: gpsResult.gpsUnavailableReason,
        processingState: 'NEEDS_REVIEW',
        channel: 'ONLINE',
        payloadHash,
        requestId
      }
    });
    if (gpsResult.location) {
      await tx.clockEventLocation.create({ data: { clockEventId: input.clientEventId, latitude: gpsResult.location.latitude, longitude: gpsResult.location.longitude } });
    }
    await tx.attendanceException.create({
      data: { type: 'CHECKOUT_WITHOUT_OPEN_SHIFT', employeeId, timesheetId, payrollPeriodId, occurredAt: timeResult.effectiveAt, siteId: input.assumedSiteId, clockEventId: input.clientEventId, status: 'OPEN' }
    });
    if (gpsResult.gpsVerification === 'VERIFIED_OUTSIDE') {
      await tx.attendanceException.create({
        data: { type: 'OUTSIDE_GEOFENCE_CHECKOUT', employeeId, timesheetId, payrollPeriodId, occurredAt: timeResult.effectiveAt, siteId: input.assumedSiteId, clockEventId: input.clientEventId, status: 'OPEN', detail: exceptionDetailForGps(gpsResult, geofence) }
      });
    } else if (gpsResult.gpsVerification === 'NOT_VERIFIED') {
      await tx.attendanceException.create({
        data: { type: 'GPS_NOT_VERIFIED', employeeId, timesheetId, payrollPeriodId, occurredAt: timeResult.effectiveAt, siteId: input.assumedSiteId, clockEventId: input.clientEventId, status: 'OPEN', detail: exceptionDetailForGps(gpsResult, geofence) }
      });
    }
    if (timeResult.exception === 'EXCESSIVE_CLOCK_SKEW') {
      await tx.attendanceException.create({
        data: { type: 'EXCESSIVE_CLOCK_SKEW', employeeId, timesheetId, payrollPeriodId, occurredAt: timeResult.effectiveAt, siteId: input.assumedSiteId, clockEventId: input.clientEventId, status: 'OPEN', detail: { clockSkewMs: timeResult.clockSkewMs.toString() } }
      });
    }
    await createAuditEvent(tx, {
      actorUserId,
      eventType: 'CLOCK_CHECK_OUT_ORPHAN',
      entityType: 'CLOCK_EVENT',
      entityId: input.clientEventId,
      requestId,
      beforeValue: null,
      afterValue: { operationType: 'CHECK_OUT', processingState: 'NEEDS_REVIEW', assumedSiteId: input.assumedSiteId }
    });
    return { kind: 'CREATED', body: await buildEventResponse(tx, input.clientEventId) };
  }

  // (a) authoritative values come from EmployeeOpenShift, never the request.
  const authoritativeSiteId = openShift.siteId;
  const authoritativeWorkAreaId = openShift.workAreaId;
  const authoritativeSourceAssignmentId = openShift.sourceAssignmentId;
  const openedAt = openShift.openedAt;

  // (b) GPS against the authoritative site's CURRENT geofence.
  const geofence = await loadCurrentGeofence(tx, authoritativeSiteId);
  const gpsResult = evaluateGpsReading(input.gps, geofence);

  // (c) effectiveAt — never blocked, never clamped itself.
  const timeResult = computeOnlineEffectiveTime(input.clientCapturedAt, serverReceivedAt);
  const effectiveAt = timeResult.effectiveAt;

  // (d) chronology clamp for the ClockShift only — see CHRONOLOGY_CLAMP_MS comment above.
  let recordedEndAtForShift: Date;
  let chronologyAnomaly: boolean;
  if (effectiveAt.getTime() <= openedAt.getTime()) {
    recordedEndAtForShift = new Date(openedAt.getTime() + CHRONOLOGY_CLAMP_MS);
    chronologyAnomaly = true;
  } else {
    recordedEndAtForShift = effectiveAt;
    chronologyAnomaly = false;
  }

  // (e) the ClockEvent itself always records the raw, unclamped effectiveAt.
  await tx.clockEvent.create({
    data: {
      id: input.clientEventId,
      groupId,
      employeeId,
      operationType: 'CHECK_OUT',
      siteId: authoritativeSiteId,
      assumedSiteId: input.assumedSiteId,
      workAreaId: authoritativeWorkAreaId,
      sourceAssignmentId: authoritativeSourceAssignmentId,
      clientCapturedAt: input.clientCapturedAt,
      capturedOffline: false,
      serverReceivedAt,
      effectiveAt,
      clockSkewMs: timeResult.clockSkewMs,
      gpsAccuracyMeters: gpsResult.gpsAccuracyMeters,
      geofenceVersionId: gpsResult.geofenceVersionId,
      gpsVerification: gpsResult.gpsVerification,
      gpsUnavailableReason: gpsResult.gpsUnavailableReason,
      processingState: 'ACCEPTED',
      channel: 'ONLINE',
      payloadHash,
      requestId
    }
  });
  // (f)
  if (gpsResult.location) {
    await tx.clockEventLocation.create({ data: { clockEventId: input.clientEventId, latitude: gpsResult.location.latitude, longitude: gpsResult.location.longitude } });
  }

  // (g) — ClockShift inserted here (ahead of candidate detection vs. the design's own step
  // numbering) so the EXISTING, already-tested overlapCandidates()/overlapExists() helpers
  // (lib/attendance-reported-projection.ts, shared with worker PATCH/correction.approve) can be
  // reused unmodified: a freshly-inserted PENDING shift with zero fragments naturally falls back
  // to its own recordedStartAt/recordedEndAt in effectiveReportedRanges (the same "fragments
  // пусто" branch the design already defines for an unmaterialized shift), which is exactly the
  // synthetic-X behavior §9.1a describes for a not-yet-inserted shift. No formula is duplicated.
  const clockShift = await tx.clockShift.create({
    data: {
      employeeId,
      checkInEventId: openShift.openedByClockEventId,
      checkOutEventId: input.clientEventId,
      siteId: authoritativeSiteId,
      workAreaId: authoritativeWorkAreaId,
      sourceAssignmentId: authoritativeSourceAssignmentId,
      recordedStartAt: openedAt,
      recordedEndAt: recordedEndAtForShift,
      endAtProvisional: chronologyAnomaly,
      materializationState: 'PENDING'
    }
  });

  // (h)
  await tx.employeeOpenShift.delete({ where: { employeeId } });

  // (i) independent post-close exceptions.
  const { timesheetId, payrollPeriodId } = await resolveTimesheetForInstant(tx, employeeId, effectiveAt);

  if (input.assumedSiteId !== authoritativeSiteId) {
    await tx.attendanceException.create({
      data: { type: 'SITE_MISMATCH_CHECKOUT', employeeId, timesheetId, payrollPeriodId, occurredAt: effectiveAt, siteId: authoritativeSiteId, clockEventId: input.clientEventId, clockShiftId: clockShift.id, status: 'OPEN', detail: { assumedSiteId: input.assumedSiteId, authoritativeSiteId } }
    });
  }
  if (gpsResult.gpsVerification === 'VERIFIED_OUTSIDE') {
    await tx.attendanceException.create({
      data: { type: 'OUTSIDE_GEOFENCE_CHECKOUT', employeeId, timesheetId, payrollPeriodId, occurredAt: effectiveAt, siteId: authoritativeSiteId, clockEventId: input.clientEventId, clockShiftId: clockShift.id, status: 'OPEN', detail: exceptionDetailForGps(gpsResult, geofence) }
    });
  } else if (gpsResult.gpsVerification === 'NOT_VERIFIED') {
    await tx.attendanceException.create({
      data: { type: 'GPS_NOT_VERIFIED', employeeId, timesheetId, payrollPeriodId, occurredAt: effectiveAt, siteId: authoritativeSiteId, clockEventId: input.clientEventId, clockShiftId: clockShift.id, status: 'OPEN', detail: exceptionDetailForGps(gpsResult, geofence) }
    });
  }
  if (chronologyAnomaly) {
    await tx.attendanceException.create({
      data: {
        type: 'CHECKOUT_CHRONOLOGY_ANOMALY',
        employeeId,
        timesheetId,
        payrollPeriodId,
        occurredAt: effectiveAt,
        siteId: authoritativeSiteId,
        clockEventId: input.clientEventId,
        clockShiftId: clockShift.id,
        // Created before Phase 1; materializeClockShiftCore links it to the final fragment in the
        // same transaction once the complete coverage batch exists. It remains NULL only while
        // materialization is legitimately deferred (e.g. missing assignment/open overlap).
        clockShiftFragmentId: null,
        status: 'OPEN',
        detail: { claimedEffectiveAt: effectiveAt.toISOString(), openedAt: openedAt.toISOString(), clampedTo: recordedEndAtForShift.toISOString() }
      }
    });
  }

  // overlap detection/transition — shared helper, no reimplementation (§9.1a).
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
        clockEventId: input.clientEventId,
        clockShiftId: clockShift.id,
        status: 'OPEN',
        detail: { durationHours: (recordedEndAtForShift.getTime() - openedAt.getTime()) / 3600000, thresholdHours: policy?.maxShiftDurationHours ?? 16 }
      }
    });
  }

  // (j)
  await createAuditEvent(tx, {
    actorUserId,
    eventType: 'CLOCK_CHECK_OUT',
    entityType: 'CLOCK_EVENT',
    entityId: input.clientEventId,
    requestId,
    beforeValue: { siteId: authoritativeSiteId, openedAt: openedAt.toISOString() },
    afterValue: { operationType: 'CHECK_OUT', processingState: 'ACCEPTED', clockShiftId: clockShift.id }
  });

  // (k) — inline materialization, same transaction, no nested transaction. Mirrors the design's
  // own `overlapBlocking` direct EXISTS check (distinct from the resolveOverlapTransition loop
  // just above, which may itself have just opened a fresh OPEN pair for this shift).
  const overlapBlocking =
    (await tx.attendanceException.count({ where: { type: 'OVERLAPPING_SHIFT', status: 'OPEN', OR: [{ clockShiftId: clockShift.id }, { relatedClockShiftId: clockShift.id }] } })) > 0;
  if (authoritativeSourceAssignmentId !== null && !overlapBlocking) {
    await materializeClockShiftCore(tx, clockShift.id, requestId);
  }
  // else: ClockShift stays PENDING — either no sourceAssignmentId to resolve fragments against,
  // or an OPEN OVERLAPPING_SHIFT still blocks materialization (§9.4 step 0/9.2 step k).

  return { kind: 'CREATED', body: await buildEventResponse(tx, input.clientEventId) };
}

export async function performCheckOut(employeeId: string, actorUserId: string, requestId: string, input: CheckOutInput): Promise<CheckOutOutcome> {
  try {
    return await prisma.$transaction(
      async (tx) => {
        await tx.$queryRaw`SELECT id FROM "Employee" WHERE id = ${employeeId}::uuid FOR UPDATE`;
        return checkOutCore(tx, employeeId, actorUserId, requestId, input, null, false);
      },
      { timeout: 15000 }
    );
  } catch (err) {
    if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === 'P2002') {
      const hashInput = checkOutHashInput(employeeId, null, input);
      const payloadHash = computeClockEventPayloadHash(hashInput);
      const outcome = await resolveConflictAfterRace(input.clientEventId, employeeId, requestId, hashInput, payloadHash);
      if (outcome === 'REPLAY') {
        return { kind: 'REPLAY', body: await buildEventResponseStandalone(input.clientEventId) };
      }
      return { kind: 'CONFLICT' };
    }
    throw err;
  }
}

// ---------------------------------------------------------------------------------------------
// 6. Switch Site (§9.3) — one HTTP request, one transaction: checkOutCore (old site, forbidOrphan)
//    then checkInCore (new site), sharing groupId. Any thrown signal rolls back both halves.
// ---------------------------------------------------------------------------------------------

export type SwitchSiteOutcome =
  | { kind: 'CREATED'; checkOut: ClockEventResponseBody; checkIn: ClockEventResponseBody; groupId: string }
  | { kind: 'REPLAY'; checkOut: ClockEventResponseBody; checkIn: ClockEventResponseBody; groupId: string }
  | { kind: 'CONFLICT' }
  | { kind: 'NO_OPEN_SHIFT' }
  | { kind: 'OUTSIDE_GEOFENCE' }
  | { kind: 'SITE_NOT_FOUND' }
  | { kind: 'WORK_AREA_INVALID' };

export async function performSwitchSite(employeeId: string, actorUserId: string, requestId: string, input: SwitchSiteInput): Promise<SwitchSiteOutcome> {
  try {
    return await prisma.$transaction(
      async (tx) => {
        await tx.$queryRaw`SELECT id FROM "Employee" WHERE id = ${employeeId}::uuid FOR UPDATE`;

        const checkOutInput: CheckOutInput = { clientEventId: input.checkOutClientEventId, assumedSiteId: input.oldAssumedSiteId, clientCapturedAt: input.checkOutClientCapturedAt, gps: input.checkOutGps };
        const checkInInput: CheckInInput = { clientEventId: input.checkInClientEventId, siteId: input.newSiteId, workAreaId: input.newWorkAreaId, clientCapturedAt: input.checkInClientCapturedAt, gps: input.checkInGps };

        // checkOutCore's own CONFLICT/SITE_NOT_FOUND both happen strictly before any business
        // mutation (replay check / assumedSite lookup precede the EmployeeOpenShift FOR UPDATE
        // lock and every write) — safe to return plainly, nothing to unwind.
        const checkOutResult = await checkOutCore(tx, employeeId, actorUserId, requestId, checkOutInput, input.groupId, true);
        if (checkOutResult.kind === 'CONFLICT') {
          return { kind: 'CONFLICT' as const };
        }
        if (checkOutResult.kind === 'SITE_NOT_FOUND') {
          return { kind: 'SITE_NOT_FOUND' as const };
        }

        // checkInCore runs SECOND — by now checkOutCore has already deleted the old
        // EmployeeOpenShift and inserted a ClockShift/ClockEvent. Any non-success outcome from
        // here on MUST throw (never return) so Prisma rolls back checkOutCore's writes too —
        // returning a plain value here would COMMIT the checkout half while silently discarding
        // the check-in half, leaving the worker "marked nowhere" (exactly what §9.3 forbids).
        const checkInResult = await checkInCore(tx, employeeId, actorUserId, requestId, checkInInput, input.groupId);
        if (checkInResult.kind === 'CONFLICT') {
          throw new SwitchCheckInFailedSignal('CONFLICT');
        }
        if (checkInResult.kind === 'SITE_NOT_FOUND') {
          throw new SwitchCheckInFailedSignal('SITE_NOT_FOUND');
        }
        if (checkInResult.kind === 'WORK_AREA_INVALID') {
          throw new SwitchCheckInFailedSignal('WORK_AREA_INVALID');
        }
        // checkInResult.kind is now 'CREATED' | 'REPLAY' ('OUTSIDE_GEOFENCE' always throws from
        // inside checkInCore itself, never returned).

        if (checkOutResult.kind === 'REPLAY' && checkInResult.kind === 'REPLAY') {
          return { kind: 'REPLAY' as const, checkOut: checkOutResult.body, checkIn: checkInResult.body, groupId: input.groupId };
        }
        if (checkOutResult.kind === 'CREATED' && checkInResult.kind === 'CREATED') {
          return { kind: 'CREATED' as const, checkOut: checkOutResult.body, checkIn: checkInResult.body, groupId: input.groupId };
        }
        // A mixed REPLAY/CREATED pair means one half's id was reused standalone with a matching
        // hash while the other is genuinely fresh — not a valid "same group, same request" replay
        // (§9.3: "частично совпавшая ... пара не применяется"). Roll back rather than silently
        // applying half a switch.
        throw new PartialSwitchReplaySignal();
      },
      { timeout: 15000 }
    );
  } catch (err) {
    if (err instanceof NoOpenShiftToSwitchSignal) {
      return { kind: 'NO_OPEN_SHIFT' };
    }
    if (err instanceof OutsideGeofenceSignal) {
      return { kind: 'OUTSIDE_GEOFENCE' };
    }
    if (err instanceof SwitchCheckInFailedSignal) {
      if (err.outcomeKind === 'CONFLICT') {
        // The whole transaction (including checkOutCore's writes AND checkInCore's own
        // conflict-record insert) was rolled back — re-record the conflict for the check-in half
        // in a fresh, isolated transaction so forensic evidence still exists despite the abort.
        const checkInInput: CheckInInput = { clientEventId: input.checkInClientEventId, siteId: input.newSiteId, workAreaId: input.newWorkAreaId, clientCapturedAt: input.checkInClientCapturedAt, gps: input.checkInGps };
        const hashInput = checkInHashInput(employeeId, input.groupId, checkInInput);
        const payloadHash = computeClockEventPayloadHash(hashInput);
        await prisma.$transaction((tx) => recordClientEventConflict(tx, employeeId, requestId, hashInput, payloadHash));
      }
      return { kind: err.outcomeKind === 'CONFLICT' ? 'CONFLICT' : err.outcomeKind };
    }
    if (err instanceof PartialSwitchReplaySignal) {
      return { kind: 'CONFLICT' };
    }
    if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === 'P2002') {
      return { kind: 'CONFLICT' };
    }
    throw err;
  }
}

class PartialSwitchReplaySignal extends Error {}
class SwitchCheckInFailedSignal extends Error {
  constructor(public outcomeKind: 'CONFLICT' | 'SITE_NOT_FOUND' | 'WORK_AREA_INVALID') {
    super();
  }
}
