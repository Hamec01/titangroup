-- Titanor Time — T14: GPS offline resilience.
--
-- The problem: at a shipyard (Meyer Turku) workers check in / out offline, inside a steel hull or
-- a covered hall. Satellite GPS is blocked and, being offline, the phone cannot use Wi-Fi / cell
-- assisted location either — the geolocation request times out with no coordinate at all
-- (accuracy "—", reason TIMEOUT). Every such check-in becomes a GPS_NOT_VERIFIED exception the
-- admin has to eyeball one by one.
--
-- Two additive changes:
--   1. ClockEventLocation can now hold an APPROXIMATE coordinate — the last good fix the device
--      still had (isApproximate=true, fixAgeSeconds), or a fix that only arrived after the event
--      was queued (capturedAfterEventSeconds). Renders on the admin map as a dashed marker,
--      never as a verified location.
--   2. WorkSite.gpsOftenUnavailable — a per-site flag. A plain TIMEOUT / POSITION_UNAVAILABLE
--      GPS exception at such a site is created already resolved instead of joining the queue.
--
-- Additive only, all defaults preserve current behaviour.

ALTER TABLE "ClockEventLocation" ADD COLUMN "isApproximate" BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE "ClockEventLocation" ADD COLUMN "fixAgeSeconds" INTEGER;
ALTER TABLE "ClockEventLocation" ADD COLUMN "capturedAfterEventSeconds" INTEGER;

-- A fresh fix carries neither age; an approximate one carries fixAgeSeconds; a back-filled one
-- carries capturedAfterEventSeconds. Never both, and the age columns are non-negative.
ALTER TABLE "ClockEventLocation"
  ADD CONSTRAINT "ck_clock_event_location_approx_shape" CHECK (
    ("fixAgeSeconds" IS NULL OR "fixAgeSeconds" >= 0)
    AND ("capturedAfterEventSeconds" IS NULL OR "capturedAfterEventSeconds" >= 0)
    AND NOT ("fixAgeSeconds" IS NOT NULL AND "capturedAfterEventSeconds" IS NOT NULL)
    AND (NOT "isApproximate" OR "fixAgeSeconds" IS NOT NULL OR "capturedAfterEventSeconds" IS NOT NULL)
  );

ALTER TABLE "WorkSite" ADD COLUMN "gpsOftenUnavailable" BOOLEAN NOT NULL DEFAULT false;
