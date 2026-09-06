-- Titanor Time — work/report-redesign FOLLOW-UP: harden the ReportFile table
--
-- Corrective migration. Does NOT edit 20260906193000_add_saved_report_files (already committed —
-- this project's convention is additive-only, never editing a past migration, same as
-- 20260819170000_fix_export_item_worked_minutes_bounds). Design per
-- docs/titanor-time/REPORT_REDESIGN_PRODUCTION_READINESS_RU.md §7.
--
-- 20260906193000 created "ReportFile" with no referential integrity and no value invariants: a
-- saved working-report PDF/CSV could carry a dangling periodId / createdByUserId, an arbitrary
-- `format` / `reportType` string, a malformed hash, a size that disagreed with the stored bytes,
-- or a header-injecting file name. This migration adds the same class of guard rails the payroll
-- "ExportBatch" table already carries (CK-39 / CK-40, 20260819150000), scoped to a user-facing —
-- and therefore deletable — analytics artifact rather than the immutable payroll export contract.
--
-- Disposable-DB check before writing: "ReportFile" exists (from 20260906193000) and, on a fresh or
-- restored database, holds zero rows at this point — every ADD CONSTRAINT below validates against
-- an empty table. No data migration.
--
-- ON DELETE choices (docs §7.2):
--   periodId        -> SET NULL  : a working report is an analytics snapshot; it must outlive its
--                                  period row exactly like PayrollPeriod.lockedByUser (SetNull).
--                                  PayrollPeriod is never hard-deleted anywhere in the codebase,
--                                  so this is defensive, not a live path.
--   createdByUserId -> RESTRICT  : identical to AuditEvent.actor and PayrollPeriod.openedByUser.
--                                  Users are archived (status), never row-deleted, so RESTRICT
--                                  adds no new breakage to user archiving.
--
-- Registered docs/titanor-time/05_RAW_SQL_REGISTER.md §17 (CK-52 .. CK-58, FK-18 .. FK-19).

-- FK-18 — periodId -> PayrollPeriod
ALTER TABLE "ReportFile"
  ADD CONSTRAINT "ReportFile_periodId_fkey"
  FOREIGN KEY ("periodId") REFERENCES "PayrollPeriod"("id")
  ON DELETE SET NULL ON UPDATE CASCADE;

-- FK-19 — createdByUserId -> User
ALTER TABLE "ReportFile"
  ADD CONSTRAINT "ReportFile_createdByUserId_fkey"
  FOREIGN KEY ("createdByUserId") REFERENCES "User"("id")
  ON DELETE RESTRICT ON UPDATE CASCADE;

-- Postgres does not auto-index the referencing side of a FK; the RESTRICT check on a (never
-- executed, but defined) user delete would otherwise seq-scan "ReportFile".
CREATE INDEX "ReportFile_createdByUserId_idx" ON "ReportFile"("createdByUserId");

-- CK-52 ck_report_file_format — only the two formats this centre can produce.
ALTER TABLE "ReportFile" ADD CONSTRAINT "ck_report_file_format" CHECK (
  "format" IN ('PDF', 'CSV')
);

-- CK-53 ck_report_file_type — closed set of working-report kinds (period / site / worker).
ALTER TABLE "ReportFile" ADD CONSTRAINT "ck_report_file_type" CHECK (
  "reportType" IN ('PERIOD_SUMMARY', 'SITE_DETAIL', 'WORKER_DETAIL')
);

-- CK-54 ck_report_file_hash_format — exactly 64 lowercase hex characters (SHA-256 hex digest),
-- same rule as CK-39 on "ExportBatch".
ALTER TABLE "ReportFile" ADD CONSTRAINT "ck_report_file_hash_format" CHECK (
  "fileHash" ~ '^[0-9a-f]{64}$'
);

-- CK-55 ck_report_file_size_matches_content — fileSizeBytes must literally equal the stored
-- content's own byte length (CK-40 on "ExportBatch"), and stay within a documented safety ceiling
-- of 25 MiB (26214400 bytes) — a company-wide period/site/worker working report is a few MB at the
-- very most; anything larger is a bug, not a legitimate document (docs §7.7).
ALTER TABLE "ReportFile" ADD CONSTRAINT "ck_report_file_size_matches_content" CHECK (
  "fileSizeBytes" = octet_length("content")
  AND "fileSizeBytes" >= 0
  AND "fileSizeBytes" <= 26214400
);

-- CK-56 ck_report_file_row_count — NULL (not applicable) or a non-negative count.
ALTER TABLE "ReportFile" ADD CONSTRAINT "ck_report_file_row_count" CHECK (
  "rowCount" IS NULL OR "rowCount" >= 0
);

-- CK-57 ck_report_file_mime_matches_format — the served Content-Type is pinned to the format, so a
-- CSV can never be handed back as application/pdf or vice versa.
ALTER TABLE "ReportFile" ADD CONSTRAINT "ck_report_file_mime_matches_format" CHECK (
  ("format" = 'PDF' AND "mimeType" = 'application/pdf') OR
  ("format" = 'CSV' AND "mimeType" = 'text/csv; charset=utf-8')
);

-- CK-58 ck_report_file_name_safe — 1..255 chars from a conservative allow-list (letters, digits,
-- dot, underscore, space, hyphen). No CR / LF / quote / path separator can reach
-- Content-Disposition, so a stored file name can never inject a response header (docs §7 download
-- safety). The generator only ever emits names like `titanor-working-report_period_2026-08-01_2026-08-14.pdf`.
ALTER TABLE "ReportFile" ADD CONSTRAINT "ck_report_file_name_safe" CHECK (
  "fileName" ~ '^[A-Za-z0-9._ -]{1,255}$'
);
