// docs/titanor-time/T12_ADMIN_TOOLS_DESIGN.md §2b — server side of the presence-sample track.
//
// A presence sample is opportunistic evidence that a worker is (or is not) on site DURING an open
// shift. It never opens/closes/moves a shift, never creates an AttendanceException, never blocks
// anything — it is written, geofence-evaluated for the admin's benefit, and that's it. Coordinates
// are stored raw (ShiftPresenceSample), same 90-day retention as ClockEventLocation.

import { Prisma } from '@prisma/client';
import { prisma } from '@/lib/prisma';
import { loadCurrentGeofence, loadMaxGpsAccuracyMeters, evaluateGpsReading } from '@/lib/attendance-clock';

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
// A device clock this far out is not a plausible "on shift right now" sample — drop it rather than
// store a misleading point. (The clock outbox has its own EXCESSIVE_CLOCK_SKEW handling; here we
// just refuse the sample.)
const MAX_PLAUSIBLE_SKEW_MS = 24 * 60 * 60 * 1000;

export interface PresenceSampleInput {
  clientSampleId: unknown;
  latitude: unknown;
  longitude: unknown;
  accuracyMeters: unknown;
  capturedAt: unknown;
  capturedOffline: unknown;
}

export type PresenceValidation =
  | { ok: true; value: { clientSampleId: string; latitude: number; longitude: number; accuracyMeters: number; capturedAt: Date; capturedOffline: boolean } }
  | { ok: false; fieldErrors: Record<string, string[]> };

export function validatePresenceSampleInput(raw: PresenceSampleInput): PresenceValidation {
  const fieldErrors: Record<string, string[]> = {};
  const num = (v: unknown): number | null => (typeof v === 'number' && Number.isFinite(v) ? v : null);

  const clientSampleId = typeof raw.clientSampleId === 'string' && UUID_RE.test(raw.clientSampleId) ? raw.clientSampleId : null;
  if (!clientSampleId) fieldErrors.clientSampleId = ['required, must be a UUID'];

  const latitude = num(raw.latitude);
  if (latitude === null || latitude < -90 || latitude > 90) fieldErrors.latitude = ['required, -90..90'];
  const longitude = num(raw.longitude);
  if (longitude === null || longitude < -180 || longitude > 180) fieldErrors.longitude = ['required, -180..180'];
  const accuracyMeters = num(raw.accuracyMeters);
  if (accuracyMeters === null || accuracyMeters < 0 || accuracyMeters > 1_000_000) fieldErrors.accuracyMeters = ['required, 0..1000000'];

  const capturedAtMs = typeof raw.capturedAt === 'string' ? Date.parse(raw.capturedAt) : NaN;
  if (Number.isNaN(capturedAtMs)) fieldErrors.capturedAt = ['required, ISO-8601 timestamp'];

  const capturedOffline = typeof raw.capturedOffline === 'boolean' ? raw.capturedOffline : null;
  if (capturedOffline === null) fieldErrors.capturedOffline = ['required, boolean'];

  if (Object.keys(fieldErrors).length > 0) {
    return { ok: false, fieldErrors };
  }
  return {
    ok: true,
    value: { clientSampleId: clientSampleId!, latitude: latitude!, longitude: longitude!, accuracyMeters: accuracyMeters!, capturedAt: new Date(capturedAtMs), capturedOffline: capturedOffline! }
  };
}

export type RecordPresenceResult =
  | { kind: 'RECORDED'; insideGeofence: boolean | null }
  | { kind: 'DUPLICATE' }
  | { kind: 'NO_OPEN_SHIFT' }
  | { kind: 'DEVICE_NOT_OWNED' }
  | { kind: 'DEVICE_REVOKED' }
  | { kind: 'CLOCK_SKEW_TOO_LARGE' };

export async function recordPresenceSample(
  employeeId: string,
  deviceInstallationId: string,
  input: { clientSampleId: string; latitude: number; longitude: number; accuracyMeters: number; capturedAt: Date; capturedOffline: boolean },
  now: Date = new Date()
): Promise<RecordPresenceResult> {
  const clockSkewMs = now.getTime() - input.capturedAt.getTime();
  if (Math.abs(clockSkewMs) > MAX_PLAUSIBLE_SKEW_MS) {
    return { kind: 'CLOCK_SKEW_TOO_LARGE' };
  }

  return prisma.$transaction(async (tx) => {
    const device = await tx.workerDeviceInstallation.findUnique({ where: { id: deviceInstallationId }, select: { employeeId: true, revokedAt: true } });
    if (!device || device.employeeId !== employeeId) {
      return { kind: 'DEVICE_NOT_OWNED' as const };
    }
    if (device.revokedAt !== null) {
      return { kind: 'DEVICE_REVOKED' as const };
    }

    const existing = await tx.shiftPresenceSample.findUnique({ where: { clientSampleId: input.clientSampleId }, select: { id: true } });
    if (existing) {
      return { kind: 'DUPLICATE' as const };
    }

    const openShift = await tx.employeeOpenShift.findUnique({ where: { employeeId }, select: { id: true, siteId: true } });
    if (!openShift) {
      // Worker checked out between capture and sync — the sample is stale evidence for a shift that
      // no longer exists. Accept the request (so the client stops retrying) but store nothing.
      return { kind: 'NO_OPEN_SHIFT' as const };
    }

    const geofence = await loadCurrentGeofence(tx, openShift.siteId);
    const maxAccuracy = await loadMaxGpsAccuracyMeters(tx);
    const evaluation = evaluateGpsReading(
      { location: { latitude: input.latitude, longitude: input.longitude, accuracyMeters: input.accuracyMeters }, gpsUnavailableReason: null },
      geofence,
      maxAccuracy
    );
    const insideGeofence = evaluation.gpsVerification === 'VERIFIED_INSIDE' ? true : evaluation.gpsVerification === 'VERIFIED_OUTSIDE' ? false : null;

    try {
      await tx.shiftPresenceSample.create({
        data: {
          clientSampleId: input.clientSampleId,
          employeeId,
          siteId: openShift.siteId,
          openShiftId: openShift.id,
          capturedAt: input.capturedAt,
          capturedOffline: input.capturedOffline,
          latitude: new Prisma.Decimal(input.latitude.toFixed(6)),
          longitude: new Prisma.Decimal(input.longitude.toFixed(6)),
          accuracyMeters: new Prisma.Decimal(input.accuracyMeters.toFixed(1)),
          geofenceVersionId: geofence?.geofenceVersionId ?? null,
          insideGeofence,
          clockSkewMs: BigInt(Math.round(clockSkewMs))
        }
      });
    } catch (error) {
      // Concurrent double-submit of the same clientSampleId — treat as the idempotent duplicate.
      if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2002') {
        return { kind: 'DUPLICATE' as const };
      }
      throw error;
    }

    return { kind: 'RECORDED' as const, insideGeofence };
  });
}
