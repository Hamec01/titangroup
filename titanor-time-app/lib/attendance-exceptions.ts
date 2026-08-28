import { Prisma } from '@prisma/client';
import { prisma } from '@/lib/prisma';

// docs/titanor-time/T7A_1_ATTENDANCE_CLOCK_DESIGN.md §11/§12.1/§12.3 — T7A.8A read-only
// foundation. This module owns ALL scope enforcement, filtering, pagination, and DTO/redaction —
// route files only do requestId/auth/permission/query-validation/HTTP mapping (see the four
// app/api/{admin,foreman}/attendance/exceptions[...] route files).
//
// No resolution mutation exists yet (attendance.exception.resolve.* is not seeded/implemented) —
// every export here is read-only. GET never writes an AuditEvent (existing read-endpoint policy).

export const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const DEFAULT_PAGE_SIZE = 20;
const MAX_PAGE_SIZE = 100;

// ---------------------------------------------------------------------------------------------
// detail JSON sanitizer — an explicit allowlist of keys actually produced by the three backend
// modules that create AttendanceException rows (lib/attendance-clock.ts, lib/attendance-sync.ts,
// lib/attendance-materializer.ts, lib/attendance-reported-projection.ts), reverse-engineered from
// their real `detail:` literals, not guessed. Unknown keys — and any nested object/array value
// even under an allowed key, since no legitimate shape ever needs one — are dropped recursively.
// This is what stands between a hypothetical stray `latitude`/`rawPayload` key and the wire.
// ---------------------------------------------------------------------------------------------
const EXCEPTION_DETAIL_ALLOWED_KEYS = new Set([
  'distanceMeters',
  'accuracyMeters',
  'thresholdMeters',
  // GPS-1 — LOW_ACCURACY / no-geofence GPS_NOT_VERIFIED context (no raw coordinates).
  'distanceToSiteMeters',
  'geofenceRadiusMeters',
  'pointInsideGeofence',
  'reason',
  'clockSkewMs',
  'assumedSiteId',
  'authoritativeSiteId',
  'claimedEffectiveAt',
  'openedAt',
  'clampedTo',
  'durationHours',
  'thresholdHours',
  'timesheetStatus',
  'triggeringClockShiftId',
  'cachedGeofenceVersionId',
  'currentGeofenceVersionId'
]);

export function sanitizeExceptionDetail(raw: unknown): Record<string, unknown> | null {
  if (raw === null || raw === undefined || typeof raw !== 'object' || Array.isArray(raw)) {
    return null;
  }
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(raw as Record<string, unknown>)) {
    if (!EXCEPTION_DETAIL_ALLOWED_KEYS.has(key)) {
      continue;
    }
    if (value === null || typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean') {
      out[key] = value;
    }
    // object/array values (even under an allowed key) are silently dropped — no known shape uses
    // one, so anything shaped like that is treated as untrusted rather than forwarded as-is.
  }
  return Object.keys(out).length > 0 ? out : null;
}

function formatDate(date: Date): string {
  return date.toISOString().slice(0, 10);
}

function employeeDisplayName(e: { firstName: string; lastName: string }): string {
  return `${e.firstName} ${e.lastName}`;
}

/** Exported for reuse by lib/attendance-exception-resolution.ts's response `resolvedBy` — the
 * exact same display-name rule as GET detail's `resolvedBy`/`employee`, never duplicated. */
export function actorDisplayName(u: { username: string; employee: { firstName: string; lastName: string } | null }): string {
  return u.employee ? employeeDisplayName(u.employee) : u.username;
}

function summaryForException(type: string, detail: Record<string, unknown> | null): string {
  switch (type) {
    case 'GPS_NOT_VERIFIED':
      return 'GPS location could not be verified';
    case 'OUTSIDE_GEOFENCE_CHECKOUT':
      return typeof detail?.distanceMeters === 'number' ? `Checked out ${detail.distanceMeters}m outside the site geofence` : 'Checked out outside the site geofence';
    case 'SITE_MISMATCH_CHECKOUT':
      return 'Checked out at a different site than expected';
    case 'DOUBLE_CHECK_IN':
      return 'A second Check In was recorded while already clocked in';
    case 'CHECKOUT_WITHOUT_OPEN_SHIFT':
      return 'Check Out recorded with no matching open shift';
    case 'STALE_ASSIGNMENT':
      return 'No current site assignment could be resolved for this event';
    case 'GEOFENCE_VERSION_MISMATCH':
      return 'Site geofence changed after this device cached it';
    case 'LATE_SYNC_AFTER_SUBMIT':
      return 'Offline record synced after the timesheet was already submitted';
    case 'MISSING_CHECKOUT_AT_CUTOFF':
      return 'Shift was still open at the payroll cutoff';
    case 'EXCESSIVE_CLOCK_SKEW':
      return 'Device clock time differs significantly from the server';
    case 'CHECKOUT_CHRONOLOGY_ANOMALY':
      return 'Check Out time was earlier than Check In and was adjusted';
    case 'EXCESSIVE_SHIFT_DURATION':
      return typeof detail?.durationHours === 'number' ? `Shift duration (${detail.durationHours.toFixed(1)}h) exceeded policy` : 'Shift duration exceeded policy';
    case 'PERIOD_BOUNDARY_SPAN':
      return 'Shift spans across a payroll period boundary';
    case 'OVERLAPPING_SHIFT':
      return 'This shift overlaps with another shift for the same employee';
    default:
      return 'Attendance exception';
  }
}

// ---------------------------------------------------------------------------------------------
// Foreman scope
// ---------------------------------------------------------------------------------------------

export interface ForemanScope {
  /** Current (validFrom<=today<=validTo|NULL) ForemanAssignment site ids — lib/foreman-review.ts's getForemanSiteIds. */
  ownSiteIds: string[];
  /** Non-null for a dual-role FOREMAN+WORKER — excludes their own exceptions from both list and detail. */
  excludeEmployeeId: string | null;
}

/** The set of siteIds an exception is provably linked to, collected from every relation that
 * carries one — never derived from AttendanceException.siteId alone, since some types (notably
 * OVERLAPPING_SHIFT) leave it NULL while still having a real site via clockShift/relatedClockShift. */
function siteScopeWhereClauses(siteIds: string[]): Prisma.AttendanceExceptionWhereInput[] {
  return [
    { siteId: { in: siteIds } },
    { clockEvent: { siteId: { in: siteIds } } },
    { clockShift: { siteId: { in: siteIds } } },
    { clockShiftFragment: { siteId: { in: siteIds } } },
    { relatedClockShift: { siteId: { in: siteIds } } }
  ];
}

// ---------------------------------------------------------------------------------------------
// List
// ---------------------------------------------------------------------------------------------

export type ExceptionStatusFilter = 'OPEN' | 'RESOLVED' | 'DISMISSED';
export type ExceptionTypeFilter =
  | 'GPS_NOT_VERIFIED'
  | 'OUTSIDE_GEOFENCE_CHECKOUT'
  | 'SITE_MISMATCH_CHECKOUT'
  | 'DOUBLE_CHECK_IN'
  | 'CHECKOUT_WITHOUT_OPEN_SHIFT'
  | 'STALE_ASSIGNMENT'
  | 'GEOFENCE_VERSION_MISMATCH'
  | 'LATE_SYNC_AFTER_SUBMIT'
  | 'MISSING_CHECKOUT_AT_CUTOFF'
  | 'EXCESSIVE_CLOCK_SKEW'
  | 'CHECKOUT_CHRONOLOGY_ANOMALY'
  | 'EXCESSIVE_SHIFT_DURATION'
  | 'PERIOD_BOUNDARY_SPAN'
  | 'OVERLAPPING_SHIFT';

export const EXCEPTION_TYPE_VALUES: ExceptionTypeFilter[] = [
  'GPS_NOT_VERIFIED',
  'OUTSIDE_GEOFENCE_CHECKOUT',
  'SITE_MISMATCH_CHECKOUT',
  'DOUBLE_CHECK_IN',
  'CHECKOUT_WITHOUT_OPEN_SHIFT',
  'STALE_ASSIGNMENT',
  'GEOFENCE_VERSION_MISMATCH',
  'LATE_SYNC_AFTER_SUBMIT',
  'MISSING_CHECKOUT_AT_CUTOFF',
  'EXCESSIVE_CLOCK_SKEW',
  'CHECKOUT_CHRONOLOGY_ANOMALY',
  'EXCESSIVE_SHIFT_DURATION',
  'PERIOD_BOUNDARY_SPAN',
  'OVERLAPPING_SHIFT'
];
export const EXCEPTION_STATUS_VALUES: ExceptionStatusFilter[] = ['OPEN', 'RESOLVED', 'DISMISSED'];

export interface ExceptionListFilters {
  status?: ExceptionStatusFilter;
  type?: ExceptionTypeFilter;
  siteId?: string;
  /** Admin-only — routes/attendance/exceptions/foreman never populates this. */
  employeeId?: string;
  payrollPeriodId?: string;
  occurredFrom?: Date;
  occurredTo?: Date;
  page: number;
  pageSize: number;
}

export interface ExceptionListItem {
  id: string;
  type: string;
  status: string;
  occurredAt: string;
  createdAt: string;
  employee: { id: string; name: string };
  site: { id: string; name: string } | null;
  payrollPeriod: { id: string; startDate: string; endDate: string } | null;
  clockEventSummary: { channel: string; capturedOffline: boolean; gpsVerification: string; gpsAccuracyMeters: number | null } | null;
  summary: string;
  resolvedAt: string | null;
  resolutionNote: string | null;
}

export interface ExceptionListResult {
  items: ExceptionListItem[];
  page: number;
  pageSize: number;
  totalItems: number;
  totalPages: number;
}

const LIST_SELECT = {
  id: true,
  type: true,
  status: true,
  occurredAt: true,
  createdAt: true,
  employeeId: true,
  employee: { select: { firstName: true, lastName: true } },
  siteId: true,
  site: { select: { name: true } },
  payrollPeriodId: true,
  payrollPeriod: { select: { startDate: true, endDate: true } },
  clockEventId: true,
  clockEvent: { select: { siteId: true, channel: true, capturedOffline: true, gpsVerification: true, gpsAccuracyMeters: true } },
  resolvedAt: true,
  resolutionNote: true,
  detail: true
} satisfies Prisma.AttendanceExceptionSelect;

type ListRow = Prisma.AttendanceExceptionGetPayload<{ select: typeof LIST_SELECT }>;

function toListItem(row: ListRow): ExceptionListItem {
  const sanitizedDetail = sanitizeExceptionDetail(row.detail);
  return {
    id: row.id,
    type: row.type,
    status: row.status,
    occurredAt: row.occurredAt.toISOString(),
    createdAt: row.createdAt.toISOString(),
    employee: { id: row.employeeId, name: employeeDisplayName(row.employee) },
    site: row.siteId && row.site ? { id: row.siteId, name: row.site.name } : null,
    payrollPeriod: row.payrollPeriodId && row.payrollPeriod ? { id: row.payrollPeriodId, startDate: formatDate(row.payrollPeriod.startDate), endDate: formatDate(row.payrollPeriod.endDate) } : null,
    clockEventSummary:
      row.clockEventId && row.clockEvent
        ? { channel: row.clockEvent.channel, capturedOffline: row.clockEvent.capturedOffline, gpsVerification: row.clockEvent.gpsVerification, gpsAccuracyMeters: row.clockEvent.gpsAccuracyMeters !== null ? Number(row.clockEvent.gpsAccuracyMeters) : null }
        : null,
    summary: summaryForException(row.type, sanitizedDetail),
    resolvedAt: row.resolvedAt ? row.resolvedAt.toISOString() : null,
    resolutionNote: row.resolutionNote
  };
}

/** Builds the WHERE Prisma.AttendanceExceptionWhereInput shared verbatim by both count() and
 * findMany() in listAttendanceExceptions — the one thing that must never drift between them. */
function buildWhere(filters: ExceptionListFilters, scope: ForemanScope | null): Prisma.AttendanceExceptionWhereInput {
  const and: Prisma.AttendanceExceptionWhereInput[] = [];
  if (filters.status) and.push({ status: filters.status });
  if (filters.type) and.push({ type: filters.type });
  if (filters.payrollPeriodId) and.push({ payrollPeriodId: filters.payrollPeriodId });
  if (filters.employeeId) and.push({ employeeId: filters.employeeId });
  if (filters.occurredFrom || filters.occurredTo) {
    and.push({ occurredAt: { gte: filters.occurredFrom, lte: filters.occurredTo } });
  }

  if (scope) {
    // Own scope is mandatory; an explicit siteId filter narrows it further but can never widen it
    // past the caller's own current sites — a foreign siteId collapses to an impossible match
    // (empty result set), never a 403/404 that would leak whether that site exists.
    const effectiveSiteIds = filters.siteId ? (scope.ownSiteIds.includes(filters.siteId) ? [filters.siteId] : []) : scope.ownSiteIds;
    and.push({ OR: siteScopeWhereClauses(effectiveSiteIds) });
    if (scope.excludeEmployeeId) {
      and.push({ employeeId: { not: scope.excludeEmployeeId } });
    }
  } else if (filters.siteId) {
    and.push({ OR: siteScopeWhereClauses([filters.siteId]) });
  }

  return { AND: and };
}

export async function listAttendanceExceptions(filters: ExceptionListFilters, scope: ForemanScope | null): Promise<ExceptionListResult> {
  if (scope && scope.ownSiteIds.length === 0) {
    return { items: [], page: filters.page, pageSize: filters.pageSize, totalItems: 0, totalPages: 0 };
  }

  const where = buildWhere(filters, scope);
  const [totalItems, rows] = await Promise.all([
    prisma.attendanceException.count({ where }),
    prisma.attendanceException.findMany({
      where,
      orderBy: [{ occurredAt: 'desc' }, { id: 'desc' }],
      skip: (filters.page - 1) * filters.pageSize,
      take: filters.pageSize,
      select: LIST_SELECT
    })
  ]);

  return { items: rows.map(toListItem), page: filters.page, pageSize: filters.pageSize, totalItems, totalPages: Math.ceil(totalItems / filters.pageSize) };
}

// ---------------------------------------------------------------------------------------------
// Detail
// ---------------------------------------------------------------------------------------------

export interface ClockShiftDetail {
  id: string;
  site: { id: string; name: string };
  workArea: { id: string; name: string } | null;
  recordedStartAt: string;
  recordedEndAt: string;
  endAtProvisional: boolean;
  materializationState: string;
  fragments: { id: string; fragmentIndex: number; payrollPeriodId: string; recordedStartAt: string; recordedEndAt: string; reportedProjectionState: string }[];
}

export interface ExceptionDetail extends ExceptionListItem {
  timesheet: { id: string; status: string } | null;
  clockEvent: {
    id: string;
    operationType: string;
    effectiveAt: string;
    serverReceivedAt: string;
    capturedOffline: boolean;
    channel: string;
    gpsVerification: string;
    gpsAccuracyMeters: number | null;
    gpsUnavailableReason: string | null;
  } | null;
  /** Redacted to null for FOREMAN when this shift's own site isn't one of their current sites —
   * "the exception is visible, its foreign side is not" (§ FOREMAN scope, own↔foreign overlap). */
  clockShift: ClockShiftDetail | null;
  relatedClockShift: ClockShiftDetail | null;
  /** Explicit allowlist sanitizer output — never the raw AttendanceException.detail JSON. */
  detail: Record<string, unknown> | null;
  resolvedBy: { id: string; name: string } | null;
  /** GPS-1 — raw retained Check In/Out coordinates + the site's current geofence, for the
   * "where was this" mini-map. Non-null ONLY when getAttendanceExceptionDetail was called with
   * `includeRawGps` (the caller holds attendance.gps.read.raw). */
  gpsLocation: { latitude: number; longitude: number } | null;
  siteGeofence: { latitude: number; longitude: number; radiusMeters: number } | null;
}

const CLOCK_SHIFT_DETAIL_SELECT = {
  id: true,
  siteId: true,
  site: { select: { name: true } },
  workAreaId: true,
  workArea: { select: { name: true } },
  recordedStartAt: true,
  recordedEndAt: true,
  endAtProvisional: true,
  materializationState: true,
  fragments: {
    select: { id: true, fragmentIndex: true, payrollPeriodId: true, recordedStartAt: true, recordedEndAt: true, reportedProjectionState: true },
    orderBy: { fragmentIndex: 'asc' }
  }
} satisfies Prisma.ClockShiftSelect;

type ClockShiftDetailRow = Prisma.ClockShiftGetPayload<{ select: typeof CLOCK_SHIFT_DETAIL_SELECT }>;

const DETAIL_SELECT = {
  ...LIST_SELECT,
  // GPS-1 — site's current geofence, for the "where was this" mini-map on GPS exceptions.
  site: { select: { name: true, currentGeofenceVersion: { select: { latitude: true, longitude: true, radiusMeters: true } } } },
  clockEvent: {
    select: {
      id: true,
      siteId: true,
      operationType: true,
      effectiveAt: true,
      serverReceivedAt: true,
      capturedOffline: true,
      channel: true,
      gpsVerification: true,
      gpsAccuracyMeters: true,
      gpsUnavailableReason: true,
      // GPS-1 — raw retained coordinates; only ever surfaced when the caller holds attendance.gps.read.raw.
      location: { select: { latitude: true, longitude: true } }
    }
  },
  clockShiftId: true,
  clockShift: { select: CLOCK_SHIFT_DETAIL_SELECT },
  relatedClockShiftId: true,
  relatedClockShift: { select: CLOCK_SHIFT_DETAIL_SELECT },
  clockShiftFragmentId: true,
  clockShiftFragment: { select: { siteId: true } },
  timesheetId: true,
  timesheet: { select: { status: true } },
  resolvedByUserId: true,
  resolvedByUser: { select: { username: true, employee: { select: { firstName: true, lastName: true } } } }
} satisfies Prisma.AttendanceExceptionSelect;

type DetailRow = Prisma.AttendanceExceptionGetPayload<{ select: typeof DETAIL_SELECT }>;

function toClockShiftDetail(row: ClockShiftDetailRow | null, ownSiteIds: string[] | null): ClockShiftDetail | null {
  if (!row) {
    return null;
  }
  if (ownSiteIds !== null && !ownSiteIds.includes(row.siteId)) {
    return null; // foreign side of an own<->foreign pair — fully redacted, not even the id.
  }
  return {
    id: row.id,
    site: { id: row.siteId, name: row.site.name },
    workArea: row.workAreaId && row.workArea ? { id: row.workAreaId, name: row.workArea.name } : null,
    recordedStartAt: row.recordedStartAt.toISOString(),
    recordedEndAt: row.recordedEndAt.toISOString(),
    endAtProvisional: row.endAtProvisional,
    materializationState: row.materializationState,
    fragments: row.fragments.map((f) => ({
      id: f.id,
      fragmentIndex: f.fragmentIndex,
      payrollPeriodId: f.payrollPeriodId,
      recordedStartAt: f.recordedStartAt.toISOString(),
      recordedEndAt: f.recordedEndAt.toISOString(),
      reportedProjectionState: f.reportedProjectionState
    }))
  };
}

/** Same safe-404 outcome for malformed id (caller must pre-validate UUID shape before calling —
 * an invalid UUID literal passed straight to Prisma's `@db.Uuid` column throws at the DB level,
 * not a clean null), missing exception, and existing-but-out-of-scope exception. */
export async function getAttendanceExceptionDetail(
  exceptionId: string,
  scope: ForemanScope | null,
  options?: { includeRawGps?: boolean }
): Promise<ExceptionDetail | null> {
  if (scope && scope.ownSiteIds.length === 0) {
    return null;
  }

  const row: DetailRow | null = await prisma.attendanceException.findUnique({ where: { id: exceptionId }, select: DETAIL_SELECT });
  if (!row) {
    return null;
  }

  if (scope) {
    if (scope.excludeEmployeeId && row.employeeId === scope.excludeEmployeeId) {
      return null;
    }
    const scopeSiteIds = [row.siteId, row.clockEvent?.siteId, row.clockShift?.siteId, row.clockShiftFragment?.siteId, row.relatedClockShift?.siteId].filter((id): id is string => !!id);
    if (!scopeSiteIds.some((id) => scope.ownSiteIds.includes(id))) {
      return null;
    }
  }

  const ownSiteIds = scope ? scope.ownSiteIds : null;
  const listItem = toListItem(row);

  return {
    ...listItem,
    timesheet: row.timesheetId && row.timesheet ? { id: row.timesheetId, status: row.timesheet.status } : null,
    clockEvent:
      row.clockEventId && row.clockEvent
        ? {
            id: row.clockEvent.id,
            operationType: row.clockEvent.operationType,
            effectiveAt: row.clockEvent.effectiveAt.toISOString(),
            serverReceivedAt: row.clockEvent.serverReceivedAt.toISOString(),
            capturedOffline: row.clockEvent.capturedOffline,
            channel: row.clockEvent.channel,
            gpsVerification: row.clockEvent.gpsVerification,
            gpsAccuracyMeters: row.clockEvent.gpsAccuracyMeters !== null ? Number(row.clockEvent.gpsAccuracyMeters) : null,
            gpsUnavailableReason: row.clockEvent.gpsUnavailableReason
          }
        : null,
    clockShift: toClockShiftDetail(row.clockShift, ownSiteIds),
    relatedClockShift: toClockShiftDetail(row.relatedClockShift, ownSiteIds),
    detail: sanitizeExceptionDetail(row.detail),
    resolvedBy: row.resolvedByUserId && row.resolvedByUser ? { id: row.resolvedByUserId, name: actorDisplayName(row.resolvedByUser) } : null,
    gpsLocation:
      options?.includeRawGps && row.clockEvent?.location
        ? { latitude: Number(row.clockEvent.location.latitude), longitude: Number(row.clockEvent.location.longitude) }
        : null,
    siteGeofence:
      options?.includeRawGps && row.site?.currentGeofenceVersion
        ? {
            latitude: Number(row.site.currentGeofenceVersion.latitude),
            longitude: Number(row.site.currentGeofenceVersion.longitude),
            radiusMeters: row.site.currentGeofenceVersion.radiusMeters
          }
        : null
  };
}

// ---------------------------------------------------------------------------------------------
// Shared query-string validation for the two list routes (admin/foreman) — kept here rather than
// duplicated in both route files, since the admin and foreman query contracts are identical except
// for whether `employeeId` is accepted at all. A value that is EXPLICITLY present and invalid is
// always a 400 with fieldErrors — never silently replaced by a default (unlike the older
// review-scopes list routes' lenient fallback behavior, deliberately NOT reused here per this
// slice's own explicit "не молча заменять явно переданное невалидное значение дефолтом" contract).
// ---------------------------------------------------------------------------------------------

export interface ExceptionListQueryInput {
  page: string | null;
  pageSize: string | null;
  status: string | null;
  type: string | null;
  siteId: string | null;
  employeeId: string | null;
  payrollPeriodId: string | null;
  from: string | null;
  to: string | null;
}

export type ExceptionListQueryResult = { ok: true; filters: ExceptionListFilters } | { ok: false; fieldErrors: Record<string, string[]> };

export function parseExceptionListQuery(input: ExceptionListQueryInput, options: { allowEmployeeId: boolean }): ExceptionListQueryResult {
  const fieldErrors: Record<string, string[]> = {};

  let page = 1;
  if (input.page !== null) {
    const n = Number(input.page);
    if (!Number.isInteger(n) || n < 1) {
      fieldErrors.page = ['must be a positive integer'];
    } else {
      page = n;
    }
  }

  let pageSize = DEFAULT_PAGE_SIZE;
  if (input.pageSize !== null) {
    const n = Number(input.pageSize);
    if (!Number.isInteger(n) || n < 1 || n > MAX_PAGE_SIZE) {
      fieldErrors.pageSize = [`must be an integer between 1 and ${MAX_PAGE_SIZE}`];
    } else {
      pageSize = n;
    }
  }

  let status: ExceptionStatusFilter = 'OPEN';
  if (input.status !== null) {
    if (!EXCEPTION_STATUS_VALUES.includes(input.status as ExceptionStatusFilter)) {
      fieldErrors.status = [`must be one of ${EXCEPTION_STATUS_VALUES.join(', ')}`];
    } else {
      status = input.status as ExceptionStatusFilter;
    }
  }

  let type: ExceptionTypeFilter | undefined;
  if (input.type !== null) {
    if (!EXCEPTION_TYPE_VALUES.includes(input.type as ExceptionTypeFilter)) {
      fieldErrors.type = [`must be one of ${EXCEPTION_TYPE_VALUES.join(', ')}`];
    } else {
      type = input.type as ExceptionTypeFilter;
    }
  }

  let siteId: string | undefined;
  if (input.siteId !== null) {
    if (!UUID_PATTERN.test(input.siteId)) {
      fieldErrors.siteId = ['must be a UUID'];
    } else {
      siteId = input.siteId;
    }
  }

  let employeeId: string | undefined;
  if (input.employeeId !== null && options.allowEmployeeId) {
    if (!UUID_PATTERN.test(input.employeeId)) {
      fieldErrors.employeeId = ['must be a UUID'];
    } else {
      employeeId = input.employeeId;
    }
  }

  let payrollPeriodId: string | undefined;
  if (input.payrollPeriodId !== null) {
    if (!UUID_PATTERN.test(input.payrollPeriodId)) {
      fieldErrors.payrollPeriodId = ['must be a UUID'];
    } else {
      payrollPeriodId = input.payrollPeriodId;
    }
  }

  let occurredFrom: Date | undefined;
  if (input.from !== null) {
    const d = new Date(input.from);
    if (Number.isNaN(d.getTime())) {
      fieldErrors.from = ['must be a valid ISO-8601 date or timestamp'];
    } else {
      occurredFrom = d;
    }
  }

  let occurredTo: Date | undefined;
  if (input.to !== null) {
    const d = new Date(input.to);
    if (Number.isNaN(d.getTime())) {
      fieldErrors.to = ['must be a valid ISO-8601 date or timestamp'];
    } else {
      occurredTo = d;
    }
  }

  if (!fieldErrors.from && !fieldErrors.to && occurredFrom && occurredTo && occurredTo.getTime() < occurredFrom.getTime()) {
    fieldErrors.to = ['before from'];
  }

  if (Object.keys(fieldErrors).length > 0) {
    return { ok: false, fieldErrors };
  }

  return { ok: true, filters: { status, type, siteId, employeeId, payrollPeriodId, occurredFrom, occurredTo, page, pageSize } };
}
