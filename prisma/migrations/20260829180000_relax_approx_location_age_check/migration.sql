-- Titanor Time — T14.3 follow-up to 20260829170000_add_gps_offline_resilience.
--
-- The original ck_clock_event_location_approx_shape required an approximate fix to always carry
-- an age (fixAgeSeconds OR capturedAfterEventSeconds). But one real approximate source has no
-- knowable age: an OS-cached position returned via getCurrentPosition({ maximumAge }) — the
-- browser hands back coordinates it had on file, and does not reliably expose how old they are.
-- "approximate, age unknown" is a legitimate state and must not be rejected.
--
-- Relaxed rule (still meaningful): the two age columns stay non-negative and mutually exclusive,
-- and a non-approximate fix may not carry an age. Dropped: "approximate implies an age".

ALTER TABLE "ClockEventLocation" DROP CONSTRAINT "ck_clock_event_location_approx_shape";

ALTER TABLE "ClockEventLocation"
  ADD CONSTRAINT "ck_clock_event_location_approx_shape" CHECK (
    ("fixAgeSeconds" IS NULL OR "fixAgeSeconds" >= 0)
    AND ("capturedAfterEventSeconds" IS NULL OR "capturedAfterEventSeconds" >= 0)
    AND NOT ("fixAgeSeconds" IS NOT NULL AND "capturedAfterEventSeconds" IS NOT NULL)
    AND ("isApproximate" OR ("fixAgeSeconds" IS NULL AND "capturedAfterEventSeconds" IS NULL))
  );
