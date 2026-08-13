import { Prisma } from '@prisma/client';
import { prisma } from '@/lib/prisma';
import { createAuditEvent } from '@/lib/audit';

// docs/titanor-time/T7A_1_ATTENDANCE_CLOCK_DESIGN.md §2.1 п.1, §2.2, §4.1, §5.1, §12.1, §12.3,
// §16 "Geofence admin" — GET/POST /api/admin/sites/:siteId/geofence-versions. WorkSiteGeofenceVersion
// is immutable/append-only (trg_geofence_version_immutable, already enforced at the DB level by the
// schema-foundation migration) — this module only ever INSERTs a new row and repoints
// WorkSite.currentGeofenceVersionId, never UPDATEs an existing version. No raw GPS coordinates from
// ClockEventLocation or employee attendance data are read or returned here — this is exclusively the
// site's own configured geofence, latitude/longitude are the site's fixed coordinates, not anyone's
// location.

const LATITUDE_MIN = -90;
const LATITUDE_MAX = 90;
const LONGITUDE_MIN = -180;
const LONGITUDE_MAX = 180;
const RADIUS_MIN = 1;
const RADIUS_MAX = 2000;
const DECIMAL_SCALE = 6;
const SCALE_FACTOR = 10 ** DECIMAL_SCALE;

export interface GeofenceVersionView {
  id: string;
  versionNumber: number;
  latitude: string;
  longitude: string;
  radiusMeters: number;
  createdByUserId: string;
  createdByUsername: string;
  createdAt: string;
}

interface RawVersionRow {
  id: string;
  versionNumber: number;
  latitude: Prisma.Decimal;
  longitude: Prisma.Decimal;
  radiusMeters: number;
  createdByUserId: string;
  createdAt: Date;
  createdByUser: { username: string };
}

const VERSION_SELECT = {
  id: true,
  versionNumber: true,
  latitude: true,
  longitude: true,
  radiusMeters: true,
  createdByUserId: true,
  createdAt: true,
  createdByUser: { select: { username: true } }
} as const;

function serializeVersion(v: RawVersionRow): GeofenceVersionView {
  return {
    id: v.id,
    versionNumber: v.versionNumber,
    // Explicit, stable decimal-string serialization (never a bare JS number) — numeric(8,6)/
    // numeric(9,6) columns always carry exactly 6 fractional digits; .toFixed(6) guarantees the
    // same shape even if the Decimal wrapper's own toString() ever trimmed trailing zeros.
    latitude: v.latitude.toFixed(DECIMAL_SCALE),
    longitude: v.longitude.toFixed(DECIMAL_SCALE),
    radiusMeters: v.radiusMeters,
    createdByUserId: v.createdByUserId,
    createdByUsername: v.createdByUser.username,
    createdAt: v.createdAt.toISOString()
  };
}

export interface GeofenceHistoryResult {
  siteId: string;
  currentGeofenceVersionId: string | null;
  current: GeofenceVersionView | null;
  items: GeofenceVersionView[];
  page: number;
  pageSize: number;
  totalItems: number;
  totalPages: number;
}

/** Returns null iff no WorkSite with this id exists — the caller turns that into 404 SITE_NOT_FOUND. */
export async function getGeofenceHistory(siteId: string, page: number, pageSize: number): Promise<GeofenceHistoryResult | null> {
  const site = await prisma.workSite.findUnique({ where: { id: siteId }, select: { id: true, currentGeofenceVersionId: true } });
  if (!site) {
    return null;
  }

  const [totalItems, items, current] = await Promise.all([
    prisma.workSiteGeofenceVersion.count({ where: { siteId } }),
    prisma.workSiteGeofenceVersion.findMany({
      where: { siteId },
      orderBy: { versionNumber: 'desc' },
      skip: (page - 1) * pageSize,
      take: pageSize,
      select: VERSION_SELECT
    }),
    site.currentGeofenceVersionId ? prisma.workSiteGeofenceVersion.findUnique({ where: { id: site.currentGeofenceVersionId }, select: VERSION_SELECT }) : Promise.resolve(null)
  ]);

  return {
    siteId: site.id,
    currentGeofenceVersionId: site.currentGeofenceVersionId,
    current: current ? serializeVersion(current) : null,
    items: items.map(serializeVersion),
    page,
    pageSize,
    totalItems,
    totalPages: Math.ceil(totalItems / pageSize)
  };
}

export interface GeofenceFieldValues {
  latitude: string;
  longitude: string;
  radiusMeters: number;
}

export type ValidateGeofenceInputResult = { ok: true; value: GeofenceFieldValues } | { ok: false; fieldErrors: Record<string, string[]> };

/**
 * Pure validation, no DB access — shared by the route so it never has to duplicate the
 * bounds/precision rules itself. Rejects (never silently rounds) any value with more than 6
 * fractional digits: round-tripping through the declared scale (`Math.round(v * 1e6) / 1e6`) is
 * exact for every finite value in the valid lat/lon range, since `v * 1e6` never exceeds
 * `1.8e8` — far inside IEEE-754 double's exact-integer range (2^53).
 */
export function validateGeofenceInput(body: Record<string, unknown>): ValidateGeofenceInputResult {
  const fieldErrors: Record<string, string[]> = {};

  const latitude = validateCoordinate(body.latitude, LATITUDE_MIN, LATITUDE_MAX, fieldErrors, 'latitude');
  const longitude = validateCoordinate(body.longitude, LONGITUDE_MIN, LONGITUDE_MAX, fieldErrors, 'longitude');

  const radiusMeters = body.radiusMeters;
  let validRadius: number | null = null;
  if (typeof radiusMeters !== 'number' || !Number.isFinite(radiusMeters)) {
    fieldErrors.radiusMeters = ['required'];
  } else if (!Number.isInteger(radiusMeters) || radiusMeters < RADIUS_MIN || radiusMeters > RADIUS_MAX) {
    fieldErrors.radiusMeters = [`must be an integer between ${RADIUS_MIN} and ${RADIUS_MAX}`];
  } else {
    validRadius = radiusMeters;
  }

  if (Object.keys(fieldErrors).length > 0 || latitude === null || longitude === null || validRadius === null) {
    return { ok: false, fieldErrors };
  }

  return { ok: true, value: { latitude, longitude, radiusMeters: validRadius } };
}

function validateCoordinate(raw: unknown, min: number, max: number, fieldErrors: Record<string, string[]>, fieldName: string): string | null {
  if (typeof raw !== 'number' || !Number.isFinite(raw)) {
    fieldErrors[fieldName] = ['required'];
    return null;
  }
  if (raw < min || raw > max) {
    fieldErrors[fieldName] = [`must be between ${min} and ${max}`];
    return null;
  }
  const rounded = Math.round(raw * SCALE_FACTOR) / SCALE_FACTOR;
  if (rounded !== raw) {
    fieldErrors[fieldName] = [`must have at most ${DECIMAL_SCALE} decimal places`];
    return null;
  }
  return raw.toFixed(DECIMAL_SCALE);
}

export type CreateGeofenceVersionError = { code: 'SITE_NOT_FOUND' };

export interface CreateGeofenceVersionResult {
  version: GeofenceVersionView;
  currentGeofenceVersionId: string;
}

/**
 * §16 "Geofence admin" step C — one transaction: WorkSite FOR UPDATE, re-check existence under the
 * lock, compute the next versionNumber from the locked state, INSERT the new (immutable) version,
 * repoint WorkSite.currentGeofenceVersionId, write the audit event. Two concurrent callers for the
 * same site serialize on the WorkSite row lock and get sequential versionNumbers; different sites
 * never block each other (no shared lock beyond each site's own row).
 */
export async function createGeofenceVersion(siteId: string, actorUserId: string, requestId: string, input: GeofenceFieldValues): Promise<CreateGeofenceVersionResult | CreateGeofenceVersionError> {
  const result = await prisma.$transaction(async (tx): Promise<CreateGeofenceVersionResult | CreateGeofenceVersionError> => {
    await tx.$queryRaw`SELECT id FROM "WorkSite" WHERE id = ${siteId}::uuid FOR UPDATE`;

    const site = await tx.workSite.findUnique({ where: { id: siteId }, select: { id: true, currentGeofenceVersionId: true } });
    if (!site) {
      return { code: 'SITE_NOT_FOUND' as const };
    }

    const lastVersion = await tx.workSiteGeofenceVersion.findFirst({
      where: { siteId },
      orderBy: { versionNumber: 'desc' },
      select: { versionNumber: true }
    });
    const versionNumber = (lastVersion?.versionNumber ?? 0) + 1;

    const created = await tx.workSiteGeofenceVersion.create({
      data: {
        siteId,
        versionNumber,
        latitude: input.latitude,
        longitude: input.longitude,
        radiusMeters: input.radiusMeters,
        createdByUserId: actorUserId
      },
      select: VERSION_SELECT
    });

    await tx.workSite.update({ where: { id: siteId }, data: { currentGeofenceVersionId: created.id } });

    // Coordinates never enter the audit trail (§14 threat model, §4.3) — only siteId/version
    // identity/radiusMeters, matching the explicit allowed shape.
    await createAuditEvent(tx, {
      actorUserId,
      eventType: 'SITE_GEOFENCE_VERSION_CREATED',
      entityType: 'WORK_SITE_GEOFENCE_VERSION',
      entityId: created.id,
      requestId,
      beforeValue: { siteId, currentGeofenceVersionId: site.currentGeofenceVersionId },
      afterValue: { siteId, currentGeofenceVersionId: created.id, versionNumber: created.versionNumber, radiusMeters: created.radiusMeters }
    });

    return { version: serializeVersion(created), currentGeofenceVersionId: created.id };
  });

  return result;
}
