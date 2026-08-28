-- Titanor Time — T12 §2b: opportunistic "still on site" GPS samples during an open shift
-- (docs/titanor-time/T12_ADMIN_TOOLS_DESIGN.md §2b).
--
-- The worker PWA captures one GPS sample when it is foregrounded and >3h have passed since the
-- last sample of the current shift (a full-background timer is impossible on iOS web); it queues
-- offline (IndexedDB presenceOutbox, DB_VERSION 3) and syncs via POST /api/worker/attendance/
-- presence. Raw coordinates, same 90-day retention as ClockEventLocation
-- (runAttendanceLocationRetention now sweeps both). clientSampleId is the client idempotency key.
-- Fully additive — a brand-new table, no change to any existing row.

CREATE TABLE "ShiftPresenceSample" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "clientSampleId" UUID NOT NULL,
    "employeeId" UUID NOT NULL,
    "siteId" UUID,
    "openShiftId" UUID,
    "capturedAt" TIMESTAMPTZ(6) NOT NULL,
    "serverReceivedAt" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "capturedOffline" BOOLEAN NOT NULL,
    "latitude" DECIMAL(8,6) NOT NULL,
    "longitude" DECIMAL(9,6) NOT NULL,
    "accuracyMeters" DECIMAL(6,1) NOT NULL,
    "geofenceVersionId" UUID,
    "insideGeofence" BOOLEAN,
    "clockSkewMs" BIGINT,
    "createdAt" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ShiftPresenceSample_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "ShiftPresenceSample_clientSampleId_key" ON "ShiftPresenceSample"("clientSampleId");
CREATE INDEX "ShiftPresenceSample_employeeId_capturedAt_idx" ON "ShiftPresenceSample"("employeeId", "capturedAt");
CREATE INDEX "ShiftPresenceSample_siteId_capturedAt_idx" ON "ShiftPresenceSample"("siteId", "capturedAt");

ALTER TABLE "ShiftPresenceSample" ADD CONSTRAINT "ShiftPresenceSample_employeeId_fkey" FOREIGN KEY ("employeeId") REFERENCES "Employee"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "ShiftPresenceSample" ADD CONSTRAINT "ShiftPresenceSample_siteId_fkey" FOREIGN KEY ("siteId") REFERENCES "WorkSite"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
