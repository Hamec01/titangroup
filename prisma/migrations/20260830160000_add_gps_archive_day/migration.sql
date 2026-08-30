-- Titanor Time — R08: GpsArchiveDay ledger (GPS encrypted archive + safe retention, TZ §9).
--
-- One row per sealed UTC reading-day of raw GPS (bucketed by ClockEvent.effectiveAt /
-- ShiftPresenceSample.capturedAt). lib/attendance-location-retention.ts deletes a raw
-- ClockEventLocation / ShiftPresenceSample row only once its day has a VERIFIED row here and no
-- un-archived row for the day remains — so a broken/late archive halts deletion instead of losing
-- data. `revision` 0 is the main file; a >2-day-late offline sync for an already-sealed day is
-- written as revision 1,2,… (an amendment), never rewriting the main file.
--
-- Disposable-DB check before writing: type "GpsArchiveStatus" and table "GpsArchiveDay" did not
-- exist (fresh names); no data migration.

CREATE TYPE "GpsArchiveStatus" AS ENUM ('WRITTEN', 'VERIFIED', 'FAILED');

CREATE TABLE "GpsArchiveDay" (
  "archiveDate" DATE NOT NULL,
  "revision" INTEGER NOT NULL DEFAULT 0,
  "status" "GpsArchiveStatus" NOT NULL,
  "clockLocationCount" INTEGER NOT NULL,
  "presenceSampleCount" INTEGER NOT NULL,
  "coveredThroughCreatedAt" TIMESTAMPTZ(6) NOT NULL,
  "plaintextSha256" VARCHAR(64),
  "ciphertextSha256" VARCHAR(64),
  "ciphertextBytes" INTEGER,
  "relativePath" VARCHAR(160),
  "errorCode" VARCHAR(64),
  "startedAt" TIMESTAMPTZ(6) NOT NULL DEFAULT now(),
  "writtenAt" TIMESTAMPTZ(6),
  "verifiedAt" TIMESTAMPTZ(6),
  "updatedAt" TIMESTAMPTZ(6) NOT NULL,

  CONSTRAINT "GpsArchiveDay_pkey" PRIMARY KEY ("archiveDate", "revision")
);

CREATE INDEX "GpsArchiveDay_status_idx" ON "GpsArchiveDay" ("status");

ALTER TABLE "GpsArchiveDay" ADD CONSTRAINT "ck_gps_archive_day_counts_nonneg"
  CHECK ("clockLocationCount" >= 0 AND "presenceSampleCount" >= 0 AND "revision" >= 0);

-- A non-FAILED row must carry the file's identity; verifiedAt is present exactly when VERIFIED.
ALTER TABLE "GpsArchiveDay" ADD CONSTRAINT "ck_gps_archive_day_written_shape"
  CHECK (
    "status" = 'FAILED'
    OR (
      "plaintextSha256" IS NOT NULL AND "ciphertextSha256" IS NOT NULL
      AND "ciphertextBytes" IS NOT NULL AND "ciphertextBytes" >= 0
      AND "relativePath" IS NOT NULL AND "writtenAt" IS NOT NULL
    )
  );
ALTER TABLE "GpsArchiveDay" ADD CONSTRAINT "ck_gps_archive_day_verified_at"
  CHECK (("status" = 'VERIFIED') = ("verifiedAt" IS NOT NULL));

-- Once VERIFIED, the row is a permanent retention-safety record: no status regression, no delete.
CREATE OR REPLACE FUNCTION fn_gps_archive_day_verified_immutable() RETURNS trigger AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    IF OLD."status" = 'VERIFIED' THEN
      RAISE EXCEPTION 'GPS_ARCHIVE_DAY_VERIFIED_NO_DELETE' USING ERRCODE = 'P0001';
    END IF;
    RETURN OLD;
  END IF;
  IF OLD."status" = 'VERIFIED' AND NEW."status" <> 'VERIFIED' THEN
    RAISE EXCEPTION 'GPS_ARCHIVE_DAY_VERIFIED_NO_REGRESSION' USING ERRCODE = 'P0001';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER trg_gps_archive_day_verified_immutable
  BEFORE UPDATE OR DELETE ON "GpsArchiveDay"
  FOR EACH ROW EXECUTE FUNCTION fn_gps_archive_day_verified_immutable();
