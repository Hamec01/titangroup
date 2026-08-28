-- Titanor Time — T12: admin direct edit of a still-in-review timesheet
-- (docs/titanor-time/T12_ADMIN_TOOLS_DESIGN.md §1b).
--
-- The admin can fix a SUBMITTED / FOREMAN_APPROVED timesheet's hours in one click with NO reason
-- prompt and NO worker-facing "Часы исправил администратор" notice. It reuses the existing
-- correction machinery: CorrectionRequest.directEdit marks such a request, and the frozen version
-- carries source=ADMIN_EDIT (not CORRECTION). Every edit is still fully in AuditEvent.
--
-- Both changes are additive. DEFAULT false / an unused enum label reproduce the old behaviour.

-- ADD VALUE IF NOT EXISTS is idempotent and, on PostgreSQL 12+, runs fine inside the migration
-- transaction as long as the new label is not itself referenced in the same transaction (it isn't).
ALTER TYPE "TimesheetVersionSource" ADD VALUE IF NOT EXISTS 'ADMIN_EDIT';

ALTER TABLE "CorrectionRequest"
  ADD COLUMN "directEdit" BOOLEAN NOT NULL DEFAULT false;
