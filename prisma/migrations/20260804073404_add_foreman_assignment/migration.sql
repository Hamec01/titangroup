-- Titanor Time — migration: add ForemanAssignment (T6.9)
--
-- Design confirmed by owner before this migration (docs/titanor-time/
-- 03_DATA_MODEL_ERD.md §4.4, unchanged): id, foremanUserId FK -> User
-- (active FOREMAN role checked in application code, not a DB constraint —
-- there's no way to scope a FK by role), siteId FK -> WorkSite,
-- isSubstitute (default false), validFrom/validTo (validTo null =
-- indefinite), assignedByUserId FK -> User, createdAt/updatedAt. All three
-- FKs onDelete: Restrict, same lifecycle as SiteAssignment — rows are
-- never physically deleted, only closed via validTo.
--
-- Structural part is the offline `prisma migrate diff` output, unedited.
-- The raw-SQL CHECK below is added manually, same pattern as CK-05
-- (ck_site_assignment_date_range) for SiteAssignment — Prisma has no
-- native CHECK constraint support. Deliberately no EXCLUDE/uniqueness on
-- overlapping dates, unlike SiteAssignment's EX-02: the ERD explicitly
-- allows multiple concurrent rows per site (primary + substitute via
-- isSubstitute), and does not otherwise constrain duplicates at the DB
-- level — enforcement, if any, is left to application logic.

-- CreateTable
CREATE TABLE "ForemanAssignment" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "foremanUserId" UUID NOT NULL,
    "siteId" UUID NOT NULL,
    "isSubstitute" BOOLEAN NOT NULL DEFAULT false,
    "validFrom" DATE NOT NULL,
    "validTo" DATE,
    "assignedByUserId" UUID NOT NULL,
    "createdAt" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "ForemanAssignment_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "ForemanAssignment_siteId_validFrom_validTo_idx" ON "ForemanAssignment"("siteId", "validFrom", "validTo");

-- AddForeignKey
ALTER TABLE "ForemanAssignment" ADD CONSTRAINT "ForemanAssignment_foremanUserId_fkey" FOREIGN KEY ("foremanUserId") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ForemanAssignment" ADD CONSTRAINT "ForemanAssignment_siteId_fkey" FOREIGN KEY ("siteId") REFERENCES "WorkSite"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ForemanAssignment" ADD CONSTRAINT "ForemanAssignment_assignedByUserId_fkey" FOREIGN KEY ("assignedByUserId") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- ck_foreman_assignment_date_range (03_DATA_MODEL_ERD.md §4.4: "CHECK: validTo IS NULL OR validTo >= validFrom")
ALTER TABLE "ForemanAssignment"
  ADD CONSTRAINT "ck_foreman_assignment_date_range"
  CHECK ("validTo" IS NULL OR "validTo" >= "validFrom");
