-- Titanor Time — T17: Check In is never blocked by GPS / geofence.
--
-- Until now a Check In whose GPS reading was a good fix but outside the site geofence
-- (VERIFIED_OUTSIDE) was REJECTED terminally: no ClockEvent, no open shift, the clock never
-- started, and — because every clock action goes through the offline outbox — the worker only saw
-- the failure after a later sync (or, before T15/T16, not at all). Owner decision: the check-in
-- must always register so the hours run; a wrong-location reading becomes a review flag, exactly
-- like GPS_NOT_VERIFIED and OUTSIDE_GEOFENCE_CHECKOUT already are.
--
-- Additive: one new enum label, unused until lib/attendance-sync.ts / lib/attendance-clock.ts
-- start writing it.

ALTER TYPE "AttendanceExceptionType" ADD VALUE IF NOT EXISTS 'OUTSIDE_GEOFENCE_CHECKIN';
